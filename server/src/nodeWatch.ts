/**
 * NodeWatch: what the NodeRegistryDO watches in its nodes on top of the control plane's own checks,
 * and the ALERT lines it raises (nodeAlerts.ts posts them to the team's channel). Each condition
 * raises one ALERT when it starts and stays quiet while it lasts; when it ends there is a plain log
 * line, and the next time it starts there is a new ALERT. Kept in memory: a restart (a deploy)
 * raises what still holds once more.
 *
 *   offline   a trusted node in service (probation or active) without a heartbeat for
 *             OFFLINE_ALERT_MS. While one is offline the object's alarm keeps running, or nothing
 *             would notice the time pass. A node out of service (suspended, banned) is not watched.
 *   egress    a node's traffic this month at EGRESS_ALERT_SHARE of its cap (at the cap it takes no
 *             more matches)
 *   lag       a node's tickLagP99Ms over LAG_ALERT_MS in LAG_ALERT_BEATS heartbeats in a row
 *   verifying the oldest match waiting for its verification, past VERIFY_ALERT_MS
 *   update    a node online below the channel's minimum for UPDATE_ALERT_MS: a verifier whose update
 *             waits for the matches of its build (ControlPlane.maybeUpdate), or a node that does not
 *             take it
 *
 * Node names and versions are what the node sent: each is cut (clip) before it goes into
 * a line, and the webhook puts the whole line in a code span.
 */
import type { MatchEntry } from '../../nodes/control-plane/controlPlane';
import type { NodeRecord } from '../../nodes/control-plane/registry';
import { compareVersions } from '../../nodes/shared/controlProtocol';

/** A trusted node's matches are void after TRUSTED_OFFLINE_MS (60 s) of silence; this long, someone should look. */
export const OFFLINE_ALERT_MS = 2 * 60_000;
export const EGRESS_ALERT_SHARE = 0.8;
/** A tick at 120 Hz is 8.33 ms: a p99 above this means the node is about to fall behind. */
export const LAG_ALERT_MS = 8;
export const LAG_ALERT_BEATS = 3;
export const VERIFY_ALERT_MS = 30 * 60_000;
export const UPDATE_ALERT_MS = 2 * 60 * 60_000;

/** A line for the object's log; one that starts with ALERT is posted under `key` (alertKey of the line when absent). */
export interface WatchNote {
  line: string;
  key?: string;
}

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

const inService = (n: NodeRecord) => n.status === 'probation' || n.status === 'active';
const minutes = (ms: number) => Math.floor(ms / 60_000);

export class NodeWatch {
  /** Trusted nodes whose offline ALERT went out (this outage). */
  private readonly offline = new Set<string>();
  private readonly egress = new Set<string>();
  /** Heartbeats in a row over LAG_ALERT_MS, and the nodes whose lag ALERT went out. */
  private readonly lagBeats = new Map<string, number>();
  private readonly lagging = new Set<string>();
  /** Since when each node is seen below the minimum, and those whose ALERT went out. */
  private readonly belowSince = new Map<string, number>();
  private readonly belowAlerted = new Set<string>();
  private verifyAlerted = false;

  /** A trusted node in service is offline: the alarm must keep running until it is back (or taken out of service). */
  watching(nodes: readonly NodeRecord[]): boolean {
    return nodes.some((n) => n.trusted && inService(n) && !n.online);
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
      } else if (n.online) {
        this.egress.delete(id);
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
          this.belowAlerted.delete(id);
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
      this.verifyAlerted = false;
    }
    return out;
  }
}
