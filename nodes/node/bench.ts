/**
 * Capacity benchmark: how many concurrent matches this machine can host, measured, not declared.
 *
 * Worst case on purpose: 3v3 with six bots (the bots' ball prediction is the heaviest part of a
 * tick). It measures CPU per second of match and resident memory per match, then
 *
 *   capacity = min( CPU: 60 % of ONE core / cpu per match-second     (one process = one core),
 *                   memory: 70 % of free RAM / memory per match,
 *                   network: 70 % of the declared uplink / 4.8 Mbit/s  (a 3v3 at 30 snapshots/s) )
 *
 * clamped to 1..200. Snapshot encoding and socket writes are not in the measured loop; the 40 %
 * CPU headroom is for them. The control plane also watches the real tick lag, so a node that
 * overstates its capacity shows up in its heartbeats.
 */
import { cpus, freemem, totalmem } from 'node:os';
import { RoomHost } from '../../server/src/roomHost';
import type { RosterEntry } from '../../server/src/roomHost';
import type { NodeCapacity, NodeSpecs } from '../shared/controlProtocol';
import { createNodeArena } from '../shared/nodeArena';
import { arch, platform } from 'node:os';

export const MBPS_PER_3V3 = 4.8;
export const MAX_MATCHES = 200;

export function nodeSpecs(): NodeSpecs {
  const c = cpus();
  return {
    cpus: c.length,
    cpuModel: (c[0]?.model ?? 'unknown').trim().slice(0, 80),
    memMB: Math.round(totalmem() / (1024 * 1024)),
    arch: arch(),
    os: platform(),
    node: process.versions.node,
  };
}

function botRoster(): RosterEntry[] {
  const r: RosterEntry[] = [];
  for (let i = 0; i < 6; i++) r.push({ slot: i, team: i < 3 ? 0 : 1, kind: 'bot', name: `Bot ${i + 1}` });
  return r;
}

export interface BenchOptions {
  /** Simulated seconds per match (default 5). */
  seconds?: number;
  /** Matches created for the measurement (default 3). */
  matches?: number;
  uplinkMbps?: number | null;
  log?: (msg: string) => void;
}

export async function runBench(opts: BenchOptions = {}): Promise<NodeCapacity> {
  const seconds = opts.seconds ?? 5;
  const k = opts.matches ?? 3;
  const log = opts.log ?? (() => undefined);
  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  const rss0 = process.memoryUsage().rss;
  const hosts: RoomHost[] = [];
  for (let i = 0; i < k; i++) {
    const roster = botRoster();
    const arena = await createNodeArena(roster, 1 + i);
    const host = new RoomHost(arena.sim, roster, { matchLengthSeconds: 300, kickoffSeed: 1 + i, kickoffCountdownSeconds: 0.5 });
    host.start();
    hosts.push(host);
  }
  gc?.();
  const memPerMatch = Math.max(8, (process.memoryUsage().rss - rss0) / k / (1024 * 1024));
  const ticks = Math.round(seconds * 120);
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  for (let t = 0; t < ticks; t++) for (const h of hosts) h.tick();
  const wallMs = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  const cpuMs = Math.max(wallMs, (cpu.user + cpu.system) / 1000);
  const cpuPerMatchSecond = cpuMs / (k * seconds);
  const byCpu = Math.floor(600 / Math.max(0.01, cpuPerMatchSecond));
  const byMem = Math.floor((freemem() / (1024 * 1024)) * 0.7 / memPerMatch);
  const up = opts.uplinkMbps ?? null;
  const byNet = up !== null && up > 0 ? Math.floor((up * 0.7) / MBPS_PER_3V3) : MAX_MATCHES;
  const matches = Math.max(1, Math.min(MAX_MATCHES, byCpu, byMem, byNet));
  log(
    `bench: ${cpuPerMatchSecond.toFixed(1)} ms CPU per 3v3-with-bots second, ${memPerMatch.toFixed(0)} MB per match -> ` +
      `cpu ${byCpu}, memory ${byMem}, network ${up === null ? 'not declared' : byNet} -> ${matches} matches`,
  );
  return {
    matches,
    cpuMsPerMatchSecond: Math.round(cpuPerMatchSecond * 100) / 100,
    memMBPerMatch: Math.round(memPerMatch),
    uplinkMbps: up,
    source: 'bench',
  };
}
