/**
 * NodeWatch: what the NodeRegistryDO watches in its nodes on top of the control plane's own checks,
 * and the ALERT lines it raises (nodeAlerts.ts posts them to the team's channel). Each condition
 * raises one ALERT when it starts and stays quiet while it lasts; when it ends there is a plain log
 * line, and the next time it starts there is a new ALERT. Kept in memory, but for the offline
 * ALERTs that went out (the object keeps those in meta): a restart (a deploy) raises the rest of
 * what still holds once more.
 *
 *   offline   a trusted node in service (probation or active) without a heartbeat for
 *             OFFLINE_ALERT_MS. Until its ALERT goes out the object's alarm keeps running, or
 *             nothing would notice the time pass; its return comes on its socket, which runs the
 *             alarm again. A node out of service (suspended, banned) is not watched:
 *             /nodes/admin/status takes one out.
 *   egress    a node's traffic this month at EGRESS_ALERT_SHARE of its cap (at the cap it takes no
 *             more matches)
 *   lag       a node's tickLagP99Ms over LAG_ALERT_MS in LAG_ALERT_BEATS heartbeats in a row
 *   verifying the oldest match waiting for its verification, past VERIFY_ALERT_MS
 *   update    a node online below the channel's minimum for UPDATE_ALERT_MS: a verifier whose update
 *             waits for the matches of its build (ControlPlane.maybeUpdate), or a node that does not
 *             take it
 *   healthz   the cron's probe of a trusted wss node (probeHealthz): no answer, a TLS or network
 *             error, an answer that is not ok or not signed by the node, or a drain nobody asked for.
 *             It catches an expired certificate while the node's heartbeats look fine. One ALERT
 *             until the node answers again, whatever kind of failure it turns into (a timeout,
 *             then a 502): a change of kind is a plain line.
 *
 * Node names, versions and answers are what the node sent: each is cut (clip) before it goes into
 * a line, and the webhook puts the whole line in a code span.
 */
import type { MatchEntry } from '../../nodes/control-plane/controlPlane';
import type { NodeRecord } from '../../nodes/control-plane/registry';
import { compareVersions, reachMessage } from '../../nodes/shared/controlProtocol';
import { randomB64, verifyWith } from '../../nodes/shared/edcrypto';
import type { FetchFn } from './nodeAlerts';

/** A node's matches are void after NODE_OFFLINE_MS (60 s) of silence; this long, someone should look. */
export const OFFLINE_ALERT_MS = 2 * 60_000;
export const EGRESS_ALERT_SHARE = 0.8;
/** A tick at 120 Hz is 8.33 ms: a p99 above this means the node is about to fall behind. */
export const LAG_ALERT_MS = 8;
export const LAG_ALERT_BEATS = 3;
export const VERIFY_ALERT_MS = 30 * 60_000;
export const UPDATE_ALERT_MS = 2 * 60 * 60_000;
/** The cron probes a node online now or seen by the object within this long. */
export const HEALTHZ_RECENT_MS = 60 * 60_000;
export const HEALTHZ_TIMEOUT_MS = 5_000;

/** A line for the object's log; one that starts with ALERT is posted under `key` (alertKey of the line when absent). */
export interface WatchNote {
  line: string;
  key?: string;
}

/** What the probe of a node's /healthz found. */
export type Healthz = { ok: true; draining: boolean } | { ok: false; kind: 'timeout' | 'tls' | 'network' | 'http' | 'answer'; detail: string };

/** The release channel as the control plane reads it ({ stable, minimum }, version strings), or null. */
export function channelOf(v: unknown): { stable: string; minimum: string } | null {
  if (typeof v !== 'object' || v === null) return null;
  const { stable, minimum } = v as Record<string, unknown>;
  const ok = (x: unknown): x is string => typeof x === 'string' && /^[0-9A-Za-z.+-]{1,32}$/.test(x);
  return ok(stable) && ok(minimum) ? { stable, minimum } : null;
}

/** At most `max` characters of something a node sent, on one line. */
export function clip(s: string, max = 40): string {
  const t = s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ');
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** A node as the lines name it: its name (cut) and its id. */
export function label(n: Pick<NodeRecord, 'name' | 'nodeId'>): string {
  return `${clip(n.name)} (${n.nodeId})`;
}

/** Where players reach a wss node over HTTPS. */
export function httpsOf(publicUrl: string): string {
  return publicUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
}

const inService = (n: NodeRecord) => n.status === 'probation' || n.status === 'active';
const minutes = (ms: number) => Math.floor(ms / 60_000);

/**
 * The nodes the cron probes: trusted wss hosts, not taken out of service by hand, online, or in
 * service and seen by this object within HEALTHZ_RECENT_MS. A restart forgets when a node was last
 * seen (lastSeen 0): an offline one is probed again once it connects, and its offline ALERT covers
 * it meanwhile. So a freshly started object probes only the nodes it has a socket of, and a
 * problem found stays known from one run to the next: its ALERT goes out once, not at every run of
 * a freshly started object.
 */
export function healthzTargets(nodes: readonly NodeRecord[], now: number): NodeRecord[] {
  return nodes.filter(
    (n) =>
      n.trusted &&
      n.roles.includes('host') &&
      n.transports.includes('wss') &&
      n.publicUrl !== null &&
      n.status !== 'banned' &&
      n.status !== 'suspended' &&
      (n.online || (inService(n) && n.lastSeen > 0 && now - n.lastSeen <= HEALTHZ_RECENT_MS)),
  );
}

/**
 * GET <publicUrl>/healthz?nonce= as players reach the node (through its TLS), within `timeoutMs`:
 * ok when it answers 200 with ok: true and the nonce signed with the node's key. A failure says
 * what kind it is; an error that names TLS, SSL or a certificate is a TLS one, any other a network one.
 */
export async function probeHealthz(n: Pick<NodeRecord, 'nodeId' | 'publicKey' | 'publicUrl'>, fetchFn: FetchFn, timeoutMs: number = HEALTHZ_TIMEOUT_MS): Promise<Healthz> {
  const nonce = randomB64(18);
  const ctrl = new AbortController();
  const run = async (): Promise<Healthz> => {
    const res = await fetchFn(`${httpsOf(n.publicUrl ?? '')}/healthz?nonce=${nonce}`, { signal: ctrl.signal });
    if (!res.ok) {
      await res.body?.cancel();
      if (res.status === 525 || res.status === 526) return { ok: false, kind: 'tls', detail: `HTTP ${res.status}: the TLS handshake or the certificate was refused` };
      const proxy = res.status === 502 || res.status === 503 || res.status === 504 ? ' (the proxy answers, the node behind it does not)' : '';
      return { ok: false, kind: 'http', detail: `HTTP ${res.status}${proxy}` };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, kind: 'answer', detail: 'an answer that is not JSON' };
    }
    const b = (typeof body === 'object' && body !== null ? body : {}) as { ok?: unknown; nodeId?: unknown; sig?: unknown; draining?: unknown };
    if (b.ok !== true) return { ok: false, kind: 'answer', detail: 'an answer without ok: true' };
    if (b.nodeId !== n.nodeId || typeof b.sig !== 'string' || !(await verifyWith(n.publicKey, reachMessage(n.nodeId, nonce), b.sig).catch(() => false))) {
      return { ok: false, kind: 'answer', detail: 'an answer not signed by this node' };
    }
    return { ok: true, draining: b.draining === true };
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), timeoutMs);
  });
  try {
    const r = await Promise.race([run(), late]);
    if (r !== 'late') return r;
    ctrl.abort();
    return { ok: false, kind: 'timeout', detail: `no answer in ${timeoutMs / 1000} s` };
  } catch (e) {
    const msg = clip(String(e).replace(/[^\x20-\x7e]+/g, ' '), 160);
    return /certificate|tls|ssl|handshake|x509/i.test(msg) ? { ok: false, kind: 'tls', detail: `TLS error (an expired or invalid certificate?): ${msg}` } : { ok: false, kind: 'network', detail: `network error: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

export class NodeWatch {
  /** Trusted nodes whose offline ALERT went out (this outage); the object keeps them in meta (offlineAlerted). */
  private readonly offline: Set<string>;
  private readonly egress = new Set<string>();
  /** Heartbeats in a row over LAG_ALERT_MS, and the nodes whose lag ALERT went out. */
  private readonly lagBeats = new Map<string, number>();
  private readonly lagging = new Set<string>();
  /** Since when each node is seen below the minimum, and those whose ALERT went out. */
  private readonly belowSince = new Map<string, number>();
  private readonly belowAlerted = new Set<string>();
  private verifyAlerted = false;
  /** The kind of /healthz problem each node has (its ALERT went out). */
  private readonly healthz = new Map<string, string>();

  /** `offlineAlerted`: the nodes whose offline ALERT went out before a restart (offlineAlerted(), as the object kept it). */
  constructor(offlineAlerted: Iterable<string> = []) {
    this.offline = new Set(offlineAlerted);
  }

  /**
   * A trusted node in service is offline and its ALERT has not gone out: the alarm must keep
   * running until it does (or the node is back, or taken out of service).
   */
  watching(nodes: readonly NodeRecord[]): boolean {
    return nodes.some((n) => n.trusted && inService(n) && !n.online && !this.offline.has(n.nodeId));
  }

  /** The nodes whose offline ALERT went out, sorted: what the object keeps in meta, so a restart does not raise them again. */
  offlineAlerted(): string[] {
    return [...this.offline].sort();
  }

  /** A maintainer set a node's status: one out of service is not watched, and back in service while still offline it is a new outage. */
  statusSet(n: NodeRecord): void {
    if (!inService(n)) this.offline.delete(n.nodeId);
  }

  /** Each heartbeat as it lands (after the Registry took it): the tick lag. */
  beat(n: NodeRecord): WatchNote | null {
    if (n.tickLagP99Ms <= LAG_ALERT_MS) {
      this.lagBeats.delete(n.nodeId);
      if (this.lagging.delete(n.nodeId)) return { line: `node ${label(n)}: tick lag p99 back to ${n.tickLagP99Ms.toFixed(1)} ms` };
      return null;
    }
    const beats = (this.lagBeats.get(n.nodeId) ?? 0) + 1;
    this.lagBeats.set(n.nodeId, beats);
    if (beats < LAG_ALERT_BEATS || this.lagging.has(n.nodeId)) return null;
    this.lagging.add(n.nodeId);
    return { line: `ALERT node ${label(n)}: tick lag p99 ${n.tickLagP99Ms.toFixed(1)} ms in ${beats} heartbeats in a row (over ${LAG_ALERT_MS} ms: its matches stutter)`, key: `lag:${n.nodeId}` };
  }

  /**
   * Every alarm (5 s): offline, egress, update and verifying. `startedAt`: when the object started,
   * so a node it never saw counts as offline from then (a deploy drops every socket). `minimum`:
   * the channel's last good minimum (null: none known, nobody is below it).
   */
  tick(now: number, nodes: readonly NodeRecord[], matches: Iterable<MatchEntry>, minimum: string | null, startedAt: number): WatchNote[] {
    const out: WatchNote[] = [];
    for (const n of nodes) {
      const id = n.nodeId;
      if (n.trusted && inService(n) && !n.online) {
        const since = Math.max(n.lastSeen, startedAt);
        if (now - since > OFFLINE_ALERT_MS && !this.offline.has(id)) {
          this.offline.add(id);
          const last = n.lastSeen > 0 ? `last heartbeat ${new Date(n.lastSeen).toISOString().slice(11, 19)} UTC` : 'not seen since the control plane started';
          out.push({ line: `ALERT trusted node ${label(n)} offline for ${minutes(now - since)} min (${last}): no match goes to it`, key: `offline:${id}` });
        }
      } else if (this.offline.delete(id) && n.online) {
        out.push({ line: `trusted node ${label(n)} back online` });
      }
      const cap = n.egressCapGB;
      if (n.online && cap !== null && cap > 0 && n.egressGB >= EGRESS_ALERT_SHARE * cap) {
        if (!this.egress.has(id)) {
          this.egress.add(id);
          const pct = Math.round((n.egressGB / cap) * 100);
          out.push({ line: `ALERT node ${label(n)} has sent ${n.egressGB.toFixed(1)} GB of its ${cap} GB monthly cap (${pct} %): at the cap it takes no more matches`, key: `egress:${id}` });
        }
      } else if (n.online && this.egress.delete(id)) {
        const of = cap !== null && cap > 0 ? `of its ${cap} GB monthly cap` : 'of its monthly cap (none now)';
        out.push({ line: `node ${label(n)} under ${Math.round(EGRESS_ALERT_SHARE * 100)} % ${of} again: ${n.egressGB.toFixed(1)} GB` });
      }
      if (n.online && minimum !== null) {
        if (compareVersions(n.build.version, minimum) < 0) {
          const since = this.belowSince.get(id) ?? now;
          this.belowSince.set(id, since);
          if (now - since > UPDATE_ALERT_MS && !this.belowAlerted.has(id)) {
            this.belowAlerted.add(id);
            out.push({
              line: `ALERT node ${label(n)} still on ${clip(n.build.version, 32)}, below the channel's minimum ${minimum}, for ${Math.floor((now - since) / 3_600_000)} h: its update is deferred or it does not take it`,
              key: `update:${id}`,
            });
          }
        } else {
          this.belowSince.delete(id);
          if (this.belowAlerted.delete(id)) out.push({ line: `node ${label(n)} now on ${clip(n.build.version, 32)}, no longer below the channel's minimum ${minimum}` });
        }
      }
    }
    let oldest: MatchEntry | null = null;
    let waiting = 0;
    for (const m of matches) {
      if (m.state !== 'verifying') continue;
      waiting++;
      if (oldest === null || m.queuedAt < oldest.queuedAt) oldest = m;
    }
    const first = oldest;
    if (first && now - first.queuedAt > VERIFY_ALERT_MS) {
      if (!this.verifyAlerted) {
        this.verifyAlerted = true;
        const host = nodes.find((n) => n.nodeId === first.nodeId);
        out.push({
          line: `ALERT ${waiting} match${waiting === 1 ? '' : 'es'} waiting for verification, the oldest (${first.assign.matchId.slice(0, 8)} on ${host ? clip(host.name) : first.nodeId}) for ${minutes(now - first.queuedAt)} min: is a verifier on its build online?`,
          key: 'verifying',
        });
      }
    } else {
      if (this.verifyAlerted) out.push({ line: `no match waiting for verification for more than ${minutes(VERIFY_ALERT_MS)} min now (${waiting} waiting)` });
      this.verifyAlerted = false;
    }
    return out;
  }

  /**
   * The cron's probe of one node. `drainExpected`: the control plane sent this node process a drain
   * or an update, or its version is below the channel's minimum (it updates). A problem is one
   * episode until the node answers again: its ALERT goes out when it starts, under one key per node.
   */
  health(n: NodeRecord, r: Healthz, drainExpected: boolean): WatchNote | null {
    const problem = !r.ok
      ? { kind: r.kind, detail: r.detail }
      : r.draining && !drainExpected
        ? { kind: 'draining', detail: 'draining, and the control plane did not ask it to (no drain, no update)' }
        : null;
    const had = this.healthz.get(n.nodeId);
    if (!problem) {
      if (had === undefined) return null;
      this.healthz.delete(n.nodeId);
      return { line: `node ${label(n)} /healthz answers again` };
    }
    if (had === problem.kind) return null;
    this.healthz.set(n.nodeId, problem.kind);
    const at = clip(httpsOf(n.publicUrl ?? ''), 120);
    if (had !== undefined) return { line: `node ${label(n)} /healthz at ${at} still fails, now: ${problem.detail}` };
    return { line: `ALERT node ${label(n)} /healthz at ${at}: ${problem.detail}`, key: `healthz:${n.nodeId}` };
  }
}
