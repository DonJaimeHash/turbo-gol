/**
 * The launcher: the only program an operator installs by hand. It keeps the node program up to
 * date by itself (the GitHub Actions runner model) and never runs bytes the project did not sign.
 *
 *   loop:
 *     channel  = GET <control>/nodes/releases/channel            { stable, minimum }
 *     release  = <data>/releases/<stable>/ (download if missing):
 *                manifest.json + manifest.sig, verified with the RELEASE public key (pinned at
 *                install time in <data>/release-key.pub, never fetched), then every file listed in
 *                the manifest with its size and SHA-256. A release whose manifest asks for a
 *                newer Node.js major (nodeMajor) is refused: the installed version keeps running
 *     run        node <data>/releases/<v>/node.mjs run --data <data>   (with an IPC channel)
 *     exit 75  = drained for an update -> loop (picks up the new stable); a version that asks for
 *                an update right after starting while the channel still points to it waits
 *                5 s, 10 s, ... up to 5 min before each new start (e.g. the stable cannot be
 *                downloaded and the version at hand is below the minimum)
 *     crash    = backoff; 3 crashes of a version within 10 minutes mark it bad and the previous
 *                good version runs again (rollback), until the channel moves on. A bad mark
 *                expires after 24 h and is cleared when the version runs for 10 minutes. When
 *                there is no fallback (every version is bad, or the good ones are below the
 *                channel minimum and could not serve), the channel's stable is retried slowly
 *
 *   stop: SIGTERM / SIGINT, or the file <data>/stop.request (checked every 2 s; how Windows asks,
 *         where there are no signals) -> { t: 'stop' } over IPC: the node drains its matches and
 *         exits, and the launcher then exits 0 whatever the node's exit code was (75 included),
 *         never starting another version. A second request, or a stop.request that says 'now',
 *         sends { t: 'stop-now' }.
 *
 * The release key signs releases; the control-plane key signs tickets; each node has its own key.
 * Three different keys, three different jobs: a stolen control plane cannot push code to nodes.
 */
import { spawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EXIT_UPDATE, compareVersions } from '../shared/controlProtocol';
import type { ReleaseChannel } from '../shared/controlProtocol';
import { importPublicKey, sha256Hex, verify } from '../shared/edcrypto';

export interface ReleaseFile {
  path: string;
  sha256: string;
  size: number;
}

export interface ReleaseManifest {
  name: 'turbogol-node';
  version: string;
  protocol: number;
  wasmSha256: string;
  /** Minimum Node.js major. */
  nodeMajor: number;
  entry: string;
  createdAt: string;
  files: ReleaseFile[];
}

export class ReleaseError extends Error {}

const SAFE_PATH = /^[A-Za-z0-9._-]+$/;
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** Parse + check a manifest against its detached signature (base64url Ed25519 over the exact bytes). */
export async function verifyManifest(manifestBytes: Uint8Array, sigB64: string, releaseKeyB64: string): Promise<ReleaseManifest> {
  const key = await importPublicKey(releaseKeyB64).catch(() => {
    throw new ReleaseError('bad release key');
  });
  if (!(await verify(key, manifestBytes, sigB64.trim()))) throw new ReleaseError('manifest signature does not verify');
  let m: ReleaseManifest;
  try {
    m = JSON.parse(new TextDecoder().decode(manifestBytes)) as ReleaseManifest;
  } catch {
    throw new ReleaseError('manifest is not JSON');
  }
  if (m.name !== 'turbogol-node' || !VERSION.test(m.version) || !Array.isArray(m.files) || m.files.length === 0 || m.files.length > 32) throw new ReleaseError('bad manifest');
  for (const f of m.files) {
    if (!f || !SAFE_PATH.test(f.path) || !/^[0-9a-f]{64}$/.test(f.sha256) || !Number.isInteger(f.size) || f.size < 0 || f.size > 64 * 1024 * 1024) throw new ReleaseError('bad manifest entry');
  }
  if (!m.files.some((f) => f.path === m.entry)) throw new ReleaseError('entry not in manifest');
  return m;
}

/** The Node.js major this launcher runs on; every node release runs on the same one (process.execPath). */
const RUNNING_NODE_MAJOR = Number(process.versions.node.split('.')[0]);

/**
 * Refuse a release built for a newer Node.js than the one running. Started anyway, it would
 * crash (or misbehave) on this machine, so the release check fails instead and the installed
 * version keeps running until the operator upgrades Node.js: the launcher is installed once and
 * never updates the system's Node.js itself.
 */
export function checkNodeMajor(m: ReleaseManifest, running = RUNNING_NODE_MAJOR): void {
  if (Number.isInteger(m.nodeMajor) && m.nodeMajor > running) {
    throw new ReleaseError(`${m.version} needs Node.js ${m.nodeMajor} or newer and this machine runs Node.js ${running}: upgrade Node.js to run it`);
  }
}

/** Check a downloaded file against its manifest entry. */
export async function checkFile(f: ReleaseFile, bytes: Uint8Array): Promise<void> {
  if (bytes.length !== f.size) throw new ReleaseError(`${f.path}: size ${bytes.length} != ${f.size}`);
  if ((await sha256Hex(bytes)) !== f.sha256) throw new ReleaseError(`${f.path}: sha256 mismatch`);
}

export interface Fetcher {
  bytes(url: string): Promise<Uint8Array>;
  json<T>(url: string): Promise<T>;
}

export const httpFetcher: Fetcher = {
  async bytes(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new ReleaseError(`GET ${url} -> ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  },
  async json<T>(url: string) {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new ReleaseError(`GET ${url} -> ${r.status}`);
    return (await r.json()) as T;
  },
};

/**
 * Make sure <dataDir>/releases/<version> holds a verified copy of the release. Downloads into a
 * temporary directory and renames it into place only when everything checked out. A release that
 * needs a newer Node.js is refused (checkNodeMajor) before any of its files is downloaded.
 */
export async function ensureRelease(control: string, dataDir: string, version: string, releaseKey: string, f: Fetcher = httpFetcher): Promise<ReleaseManifest> {
  if (!VERSION.test(version)) throw new ReleaseError('bad version');
  const dir = join(dataDir, 'releases', version);
  let local: ReleaseManifest | null = null;
  try {
    const mb = new Uint8Array(await readFile(join(dir, 'manifest.json')));
    const sig = await readFile(join(dir, 'manifest.sig'), 'utf8');
    const m = await verifyManifest(mb, sig, releaseKey);
    for (const file of m.files) await checkFile(file, new Uint8Array(await readFile(join(dir, file.path))));
    local = m;
  } catch {
    /* missing or damaged: fetch it */
  }
  if (local) {
    checkNodeMajor(local);
    return local;
  }
  const base = `${control.replace(/\/$/, '')}/nodes/releases/${version}`;
  const mb = await f.bytes(`${base}/manifest.json`);
  const sig = new TextDecoder().decode(await f.bytes(`${base}/manifest.sig`));
  const m = await verifyManifest(mb, sig, releaseKey);
  if (m.version !== version) throw new ReleaseError('manifest version differs from the channel');
  checkNodeMajor(m);
  const tmp = join(dataDir, 'releases', `.${version}.${Date.now()}`);
  await mkdir(tmp, { recursive: true });
  try {
    for (const file of m.files) {
      const bytes = await f.bytes(`${base}/${file.path}`);
      await checkFile(file, bytes);
      await writeFile(join(tmp, file.path), bytes);
    }
    await writeFile(join(tmp, 'manifest.json'), mb);
    await writeFile(join(tmp, 'manifest.sig'), sig);
    await rm(dir, { recursive: true, force: true });
    await rename(tmp, dir);
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    throw e;
  }
  return m;
}

// ---- crash bookkeeping (pure) ------------------------------------------------------------------

export interface LaunchState {
  /** Last version that ran for at least STABLE_RUN_MS. */
  lastGood: string | null;
  /** Versions that crashed CRASH_LIMIT times within CRASH_WINDOW_MS. */
  bad: string[];
  /** When each bad mark was set (ms since the epoch); a mark expires after BAD_TTL_MS. */
  badAt: Record<string, number>;
  crashes: Record<string, number[]>;
}

export const CRASH_LIMIT = 3;
export const CRASH_WINDOW_MS = 10 * 60_000;
export const STABLE_RUN_MS = 5 * 60_000;
/** A bad mark is forgotten after this long: a crash caused by the machine (port in use, disk full) must not ban a version for good. */
export const BAD_TTL_MS = 24 * 60 * 60_000;
/** Crash restarts wait 5 s, doubling up to this. */
export const CRASH_BACKOFF_MAX_MS = 60_000;
/** "No release yet" and "every version is bad" retries wait 5 s, doubling up to this. */
export const RETRY_MAX_MS = 5 * 60_000;
/** An exit 75 this soon after starting means the node was told to update at once (it is below the channel minimum). */
export const QUICK_UPDATE_EXIT_MS = 60_000;
/** Starting such a version again waits this long, doubling up to UPDATE_RETRY_MAX_MS. */
export const UPDATE_RETRY_MIN_MS = 5_000;
export const UPDATE_RETRY_MAX_MS = 5 * 60_000;
/** <data>/stop.request: a stop request from a program that cannot send signals (install-windows.ps1 -Stop). */
export const STOP_FILE = 'stop.request';
export const STOP_POLL_MS = 2_000;
/** A stop.request already this old when the launcher starts was left behind by a requester that gave up: removed, not obeyed. */
export const STALE_STOP_MS = 30 * 60_000;

export function emptyState(): LaunchState {
  return { lastGood: null, bad: [], badAt: {}, crashes: {} };
}

/** Record a crash of `version`; returns true when that made it bad. */
export function recordCrash(s: LaunchState, version: string, now: number): boolean {
  const list = (s.crashes[version] ?? []).filter((t) => now - t < CRASH_WINDOW_MS);
  list.push(now);
  s.crashes[version] = list;
  if (list.length >= CRASH_LIMIT && !s.bad.includes(version)) {
    s.bad.push(version);
    s.badAt[version] = now;
    return true;
  }
  return false;
}

/**
 * Forget the bad marks older than BAD_TTL_MS, with that version's crash history. A mark with no
 * valid time (written by an older launcher, or set by a clock that has since gone back) starts its
 * 24 h now. Returns the versions it cleared.
 */
export function expireBad(s: LaunchState, now: number): string[] {
  const cleared: string[] = [];
  s.bad = s.bad.filter((v) => {
    const at = s.badAt[v];
    if (typeof at !== 'number' || !Number.isFinite(at) || at > now) {
      s.badAt[v] = now;
      return true;
    }
    if (now - at < BAD_TTL_MS) return true;
    cleared.push(v);
    delete s.badAt[v];
    delete s.crashes[v];
    return false;
  });
  for (const v of Object.keys(s.badAt)) if (!s.bad.includes(v)) delete s.badAt[v];
  return cleared;
}

/**
 * Book a run of `version` that lasted `ranMs`, whatever its exit code: STABLE_RUN_MS makes it the
 * last good version; CRASH_WINDOW_MS clears its crash history and its bad mark (whatever made it
 * crash before is gone). Returns true when a bad mark was cleared.
 */
export function recordRun(s: LaunchState, version: string, ranMs: number): boolean {
  if (ranMs >= STABLE_RUN_MS) s.lastGood = version;
  if (ranMs < CRASH_WINDOW_MS) return false;
  delete s.crashes[version];
  delete s.badAt[version];
  const wasBad = s.bad.includes(version);
  if (wasBad) s.bad = s.bad.filter((v) => v !== version);
  return wasBad;
}

/**
 * Which version to run: the channel's stable unless it is bad, then the last good one, then the
 * newest installed one. A fallback below channel.minimum is no candidate: the control plane tells
 * it to update as soon as it logs in, so it could never serve (scripts/build-node.mjs publishes
 * minimum = stable, so after an update every older version is below it). null = nothing to fall
 * back on: the caller retries the stable anyway, slowly (a crash that marked it bad may well have
 * been the machine's: a port in use, a full disk).
 */
export function chooseVersion(s: LaunchState, channel: ReleaseChannel, installed: string[]): string | null {
  if (!s.bad.includes(channel.stable)) return channel.stable;
  const min = typeof channel.minimum === 'string' && VERSION.test(channel.minimum) ? channel.minimum : null;
  const usable = (v: string): boolean => !s.bad.includes(v) && installed.includes(v) && (min === null || compareVersions(v, min) >= 0);
  if (s.lastGood && usable(s.lastGood)) return s.lastGood;
  const ok = installed.filter(usable).sort(compareVersions);
  return ok.length > 0 ? ok[ok.length - 1] : null;
}

/** Without the channel (offline): the last good version if it is installed and not bad, else the newest installed one that is not bad. */
export function offlineVersion(s: LaunchState, installed: string[]): string | null {
  if (s.lastGood && !s.bad.includes(s.lastGood) && installed.includes(s.lastGood)) return s.lastGood;
  const ok = installed.filter((v) => !s.bad.includes(v)).sort(compareVersions);
  return ok.length > 0 ? ok[ok.length - 1] : null;
}

// ---- the loop ---------------------------------------------------------------------------------

export interface LauncherOptions {
  control: string;
  dataDir: string;
  releaseKey: string;
  /** Extra args for `node.mjs run` (port, listen address, egress cap...). */
  runArgs?: string[];
  fetcher?: Fetcher;
  log?: (msg: string) => void;
  /** Turn this process's SIGTERM / SIGINT into stop requests (default true). */
  handleSignals?: boolean;
  /** How often <data>/stop.request is looked for (default STOP_POLL_MS). */
  stopPollMs?: number;
  /** Every wait between starts goes through this when given (tests record them); a stop request cuts a wait short either way. */
  sleep?: (ms: number) => Promise<void>;
}

/** What the launcher sends the node over IPC (node/main.ts): drain and exit 0, or stop right away. */
export type LauncherMessage = { t: 'stop' } | { t: 'stop-now' };

type StopSignal = 'SIGTERM' | 'SIGINT';

/** The parts of a child process with an IPC channel the launcher uses (types/node-shim.d.ts declares fewer). */
interface NodeChild {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly connected: boolean;
  send(message: LauncherMessage, callback: (err: Error | null) => void): boolean;
  kill(signal?: StopSignal | 'SIGKILL'): boolean;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}
const spawnWithIpc = spawn as unknown as (cmd: string, args: string[], opts: { stdio: Array<'inherit' | 'ipc'> }) => NodeChild;
const statFile = (path: string): Promise<{ mtimeMs: number; size: number }> =>
  (fsp as unknown as { stat(p: string): Promise<{ mtimeMs: number; size: number }> }).stat(path);

interface Pick {
  version: string | null;
  /** The stable is bad and there is nothing to fall back on (chooseVersion): it is tried again anyway, slowly. */
  lastResort: boolean;
  channel: ReleaseChannel | null;
}

async function loadState(dataDir: string): Promise<LaunchState> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(dataDir, 'launcher.json'), 'utf8'));
  } catch {
    return emptyState();
  }
  const s = emptyState();
  if (!raw || typeof raw !== 'object') return s;
  const r = raw as Partial<Record<keyof LaunchState, unknown>>;
  if (typeof r.lastGood === 'string') s.lastGood = r.lastGood;
  if (Array.isArray(r.bad)) s.bad = r.bad.filter((v): v is string => typeof v === 'string');
  if (r.badAt && typeof r.badAt === 'object') {
    for (const [v, t] of Object.entries(r.badAt as Record<string, unknown>)) if (typeof t === 'number') s.badAt[v] = t;
  }
  if (r.crashes && typeof r.crashes === 'object') {
    for (const [v, l] of Object.entries(r.crashes as Record<string, unknown>)) {
      if (Array.isArray(l)) s.crashes[v] = l.filter((t): t is number => typeof t === 'number');
    }
  }
  return s;
}

async function installedVersions(dataDir: string): Promise<string[]> {
  try {
    return (await readdir(join(dataDir, 'releases'))).filter((v) => VERSION.test(v));
  } catch {
    return [];
  }
}

const secs = (ms: number): number => Math.round(ms / 1000);
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The supervised loop. One instance per process: run() resolves with the exit code (0) once a
 * stop was requested and no node is running, or when the node stopped by itself.
 */
export class Launcher {
  private readonly o: LauncherOptions;
  private readonly log: (msg: string) => void;
  /** 0 running, 1 stop requested (the node drains), 2 stop now. */
  private stopLevel = 0;
  private child: NodeChild | null = null;
  /** Pending waits, resolved early by a stop request. */
  private readonly wakers = new Set<() => void>();
  private polling = false;
  /** mtime:size of a stop.request already obeyed that could not be deleted (not obeyed twice). */
  private handledStop = '';

  constructor(o: LauncherOptions) {
    this.o = o;
    this.log = o.log ?? ((m: string) => console.log(`[launcher] ${m}`));
  }

  get stopping(): boolean {
    return this.stopLevel > 0;
  }

  /**
   * A stop request (SIGTERM, SIGINT, stop.request): the first asks the node to drain (its matches
   * end normally) and the second, or one with now=true, to stop at once. Either way the launcher
   * exits 0 as soon as no node is running, and starts nothing new.
   */
  requestStop(source: string, now = false, signal?: StopSignal): void {
    const level = now || this.stopLevel > 0 ? 2 : 1;
    this.log(level === 1 ? `stop requested (${source}): the node finishes its matches, then the launcher exits` : `stop now requested (${source})`);
    this.stopLevel = Math.max(this.stopLevel, level);
    this.tellChild(level === 2 ? 'stop-now' : 'stop', signal);
    for (const wake of [...this.wakers]) wake();
  }

  async run(): Promise<number> {
    const signals = this.o.handleSignals !== false;
    const onTerm = (): void => this.requestStop('SIGTERM', false, 'SIGTERM');
    const onInt = (): void => this.requestStop('SIGINT', false, 'SIGINT');
    if (signals) {
      process.on('SIGTERM', onTerm);
      process.on('SIGINT', onInt);
    }
    let poll: ReturnType<typeof setInterval> | undefined;
    try {
      await this.dropStaleStopFile();
      await this.pollStopFile();
      poll = setInterval(() => void this.pollStopFile(), this.o.stopPollMs ?? STOP_POLL_MS);
      return await this.loop();
    } finally {
      if (poll !== undefined) clearInterval(poll);
      if (signals) {
        process.off('SIGTERM', onTerm);
        process.off('SIGINT', onInt);
      }
    }
  }

  // ---- stop requests ------------------------------------------------------------------------

  /** Tell the running node, over IPC; a signal only when the channel is gone (on Windows any signal is TerminateProcess). */
  private tellChild(t: LauncherMessage['t'], signal?: StopSignal): void {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const fallback = (): void => {
      const sig: StopSignal | 'SIGKILL' = t === 'stop' ? (signal ?? 'SIGTERM') : signal === 'SIGINT' ? 'SIGINT' : 'SIGKILL';
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    };
    if (!child.connected) {
      fallback();
      return;
    }
    const msg: LauncherMessage = { t };
    try {
      child.send(msg, (err) => {
        if (err) fallback();
      });
    } catch {
      fallback();
    }
  }

  private stopFile(): string {
    return join(this.o.dataDir, STOP_FILE);
  }

  private async dropStaleStopFile(): Promise<void> {
    try {
      const st = await statFile(this.stopFile());
      if (Date.now() - st.mtimeMs <= STALE_STOP_MS) return;
      await rm(this.stopFile(), { force: true });
      this.log(`removed an old ${STOP_FILE} (written ${new Date(st.mtimeMs).toISOString()}) without obeying it`);
    } catch {
      /* none */
    }
  }

  /** <data>/stop.request: delete it and stop ('now' in it: stop at once). */
  private async pollStopFile(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const file = this.stopFile();
      let stamp: string;
      try {
        const st = await statFile(file);
        stamp = `${st.mtimeMs}:${st.size}`;
      } catch {
        return;
      }
      const fresh = stamp !== this.handledStop;
      const text = fresh ? await readFile(file, 'utf8').catch(() => '') : '';
      this.handledStop = stamp;
      try {
        await rm(file);
        this.handledStop = '';
      } catch {
        /* still there (locked): remembered by its stamp so it is not obeyed twice */
      }
      if (fresh) this.requestStop(STOP_FILE, /\bnow\b/i.test(text));
    } finally {
      this.polling = false;
    }
  }

  // ---- waiting ------------------------------------------------------------------------------

  /** Wait `ms` (through o.sleep when given), cut short by a stop request. */
  private wait(ms: number): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        this.wakers.delete(done);
        resolve();
      };
      this.wakers.add(done);
      if (this.o.sleep) this.o.sleep(ms).then(done, done);
      else timer = setTimeout(done, ms);
    });
  }

  /** `p`, or null as soon as a stop is requested (a download in progress is abandoned). */
  private async orStop<T>(p: Promise<T>): Promise<T | null> {
    p.catch(() => undefined);
    if (this.stopping) return null;
    let wake: (() => void) | undefined;
    const stop = new Promise<null>((resolve) => {
      wake = () => resolve(null);
      this.wakers.add(wake);
    });
    try {
      return await Promise.race([p, stop]);
    } finally {
      if (wake) this.wakers.delete(wake);
    }
  }

  // ---- the loop -----------------------------------------------------------------------------

  private async save(s: LaunchState): Promise<void> {
    try {
      await writeFile(join(this.o.dataDir, 'launcher.json'), JSON.stringify(s, null, 2));
    } catch (e) {
      this.log(`could not save launcher.json: ${errText(e)}`);
    }
  }

  private stopped(): number {
    this.log('stopped');
    return 0;
  }

  private async pickVersion(state: LaunchState): Promise<Pick> {
    const o = this.o;
    const f = o.fetcher ?? httpFetcher;
    let channel: ReleaseChannel | null = null;
    try {
      channel = await f.json<ReleaseChannel>(`${o.control.replace(/\/$/, '')}/nodes/releases/channel`);
      let version = chooseVersion(state, channel, await installedVersions(o.dataDir));
      const lastResort = !version;
      if (!version) version = channel.stable;
      await ensureRelease(o.control, o.dataDir, version, o.releaseKey, f);
      return { version, lastResort, channel };
    } catch (e) {
      this.log(`release check failed: ${errText(e)}`);
      // Offline, or the release needs a newer Node.js: keep running what we have.
      return { version: offlineVersion(state, await installedVersions(o.dataDir)), lastResort: false, channel };
    }
  }

  private async loop(): Promise<number> {
    const o = this.o;
    const log = this.log;
    let backoff = 5_000; // crash restarts
    let retry = 5_000; // no release yet / every version bad
    let updateWait = UPDATE_RETRY_MIN_MS; // a version that asks for an update right after starting
    let waitedForUpdate = false;
    let last: { version: string; code: number; ranMs: number } | null = null;
    for (;;) {
      if (this.stopping) return this.stopped();
      const state = await loadState(o.dataDir);
      for (const v of expireBad(state, Date.now())) log(`the bad mark of ${v} expired: it may run again`);
      const pick = await this.orStop(this.pickVersion(state));
      if (!pick || this.stopping) return this.stopped();
      const { version, channel } = pick;
      if (!version) {
        log(`no release available yet; retrying in ${secs(retry)} s`);
        await this.wait(retry);
        retry = Math.min(retry * 2, RETRY_MAX_MS);
        continue;
      }
      if (pick.lastResort) {
        const min = channel && typeof channel.minimum === 'string' ? channel.minimum : '?';
        log(`${version} is marked bad and there is no other version to run (none here is good and at least the channel minimum ${min}): trying ${version} again in ${secs(retry)} s (running ${CRASH_WINDOW_MS / 60_000} minutes clears a mark; marks expire after ${BAD_TTL_MS / 3_600_000} h)`);
        await this.wait(retry);
        retry = Math.min(retry * 2, RETRY_MAX_MS);
        if (this.stopping) return this.stopped();
      } else {
        retry = 5_000;
      }

      // Exit 75 right after starting, and the channel still leads to the same version: it would only
      // log in, be told to update and exit again (the stable could not be downloaded and the version
      // at hand is below the minimum, or the channel and the control plane disagree). Wait, longer
      // each time, then look at the channel again (and retry the download) and start it once more.
      const quick = last !== null && last.code === EXIT_UPDATE && last.ranMs < QUICK_UPDATE_EXIT_MS && last.version === version;
      if (quick && !waitedForUpdate) {
        const below = channel && typeof channel.minimum === 'string' && compareVersions(version, channel.minimum) < 0 ? `, below the channel minimum ${channel.minimum}` : '';
        log(`${version} exited for an update right after starting and is still the version to run${below}: starting it again in ${secs(updateWait)} s`);
        waitedForUpdate = true;
        await this.wait(updateWait);
        updateWait = Math.min(updateWait * 2, UPDATE_RETRY_MAX_MS);
        continue;
      }
      if (!quick) updateWait = UPDATE_RETRY_MIN_MS;
      waitedForUpdate = false;

      let entry: string;
      try {
        const manifest = JSON.parse(await readFile(join(o.dataDir, 'releases', version, 'manifest.json'), 'utf8')) as ReleaseManifest;
        entry = join(o.dataDir, 'releases', version, manifest.entry);
      } catch (e) {
        log(`cannot read the manifest of ${version} (${errText(e)}); retrying in ${secs(backoff)} s`);
        await this.wait(backoff);
        backoff = Math.min(backoff * 2, CRASH_BACKOFF_MAX_MS);
        continue;
      }
      if (this.stopping) return this.stopped();
      log(`starting ${version}`);
      const t0 = Date.now();
      const code = await this.runChild(entry, ['run', '--data', o.dataDir, ...(o.runArgs ?? [])]);
      const ranMs = Date.now() - t0;
      last = { version, code, ranMs };
      if (recordRun(state, version, ranMs)) log(`${version} ran for ${Math.round(ranMs / 60_000)} minutes: its bad mark is cleared`);
      if (this.stopping) {
        // Whatever the code (75 = it was draining for an update when the stop came): no new start.
        log(`node exited with ${code} after the stop request`);
        await this.save(state);
        return this.stopped();
      }
      if (code === 0) {
        log('node stopped');
        await this.save(state);
        return 0;
      }
      if (code === EXIT_UPDATE) {
        log('node drained for an update');
        await this.save(state);
        backoff = 5_000;
        continue;
      }
      if (ranMs >= STABLE_RUN_MS) backoff = 5_000;
      if (recordCrash(state, version, Date.now())) log(`version ${version} crashed ${CRASH_LIMIT} times: marked bad, rolling back`);
      else log(`node exited with ${code}; restarting in ${secs(backoff)} s`);
      await this.save(state);
      await this.wait(backoff);
      backoff = Math.min(backoff * 2, CRASH_BACKOFF_MAX_MS);
    }
  }

  /** One run of the node, with an IPC channel for stop requests. Resolves with its exit code. */
  private runChild(entry: string, args: string[]): Promise<number> {
    return new Promise((resolve) => {
      let child: NodeChild;
      try {
        child = spawnWithIpc(process.execPath, [entry, ...args], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
      } catch (e) {
        this.log(`could not start the node: ${errText(e)}`);
        resolve(1);
        return;
      }
      this.child = child;
      let settled = false;
      const finish = (code: number): void => {
        if (settled) return;
        settled = true;
        if (this.child === child) this.child = null;
        resolve(code);
      };
      child.on('error', (e) => {
        this.log(`node process: ${e.message}`);
        if (child.pid === undefined) finish(1); // it never started
      });
      child.on('exit', (code, signal) => finish(code ?? (signal ? 128 : 1)));
      // A stop that came in while it was being started.
      if (this.stopLevel > 0) this.tellChild(this.stopLevel === 2 ? 'stop-now' : 'stop');
    });
  }
}

/** The launcher's main loop (launcherMain.ts `run`): resolves with the process exit code. */
export function launcherLoop(o: LauncherOptions): Promise<number> {
  return new Launcher(o).run();
}
