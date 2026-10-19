/**
 * turbogol-node: the community node program.
 *
 *   register --control <url> --token <tgn1_...> [--transport wss|rtc] [--public-url wss://<ip>]
 *            [--roles host,verify]   'wss' = public IP with ports 80/443 (a VPS); 'rtc' = a home PC
 *            behind NAT, nothing to open (WebRTC). Default: wss when --public-url is given, else rtc.
 *            [--name <name>] [--uplink-mbps <n>] [--data <dir>]
 *        One time. Generates this machine's Ed25519 key (it never leaves <data>/node.json), runs the
 *        capacity benchmark, trades the one-time token for a node identity.
 *   run      [--data <dir>] [--port 7350] [--listen 127.0.0.1] [--egress-cap-gb <n>]
 *        Serves matches / verifications until stopped. SIGTERM (or { t: 'stop' } over the IPC
 *        channel from the launcher) drains: no new matches, exit 0 when the last one ends and is
 *        reported; { t: 'stop-now' } stops at once. Exit code 75 = drained for an update (the
 *        launcher restarts it); a requested stop always exits 0, even if an update came meanwhile.
 *   bench    [--seconds 5] [--uplink-mbps <n>]
 *   verify   <replay-file>          re-simulate a replay locally (debugging)
 *   status   [--data <dir>]
 *   rtc-test [--stun <url>] [--turn <url> --turn-user <u> --turn-pass <p>]   WebRTC reachability check
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PROTOCOL_VERSION } from '../../src/net/protocol';
import type { BuildId, NodeCapacity, NodeRole, NodeTransport } from '../shared/controlProtocol';
import { loadWasm, nodeSimFactory } from '../shared/nodeArena';
import { verifyReplay } from '../shared/verify';
import { nodeSpecs, runBench } from './bench';
import { registerNode } from './register';
import { NodeRuntime } from './runtime';
import { rtcSelfTest } from './rtcTransport';
import type { NodeIdentityFile } from './runtime';
import { NODE_VERSION } from './version';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf('--' + name);
  if (i > 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  const env = process.env['TGN_' + name.toUpperCase().replace(/-/g, '_')];
  return env ?? def;
}

function fail(msg: string): never {
  console.error(`turbogol-node: ${msg}`);
  process.exit(2);
}

async function buildId(): Promise<BuildId> {
  const w = await loadWasm();
  return { version: NODE_VERSION, protocol: PROTOCOL_VERSION, wasmSha256: w.sha256 };
}

function dataDir(): string {
  return resolve(arg('data', process.env.TGN_DATA ?? './data') as string);
}

async function readIdentity(dir: string): Promise<NodeIdentityFile> {
  try {
    return JSON.parse(await readFile(join(dir, 'node.json'), 'utf8')) as NodeIdentityFile;
  } catch {
    return fail(`no node.json in ${dir}: run 'register' first`);
  }
}

/** The benchmark result for this build + machine, re-measured when either changed. */
async function capacityFor(dir: string, build: BuildId, uplink: number | null): Promise<NodeCapacity> {
  const specs = nodeSpecs();
  const key = `${build.wasmSha256}|${specs.cpuModel}|${specs.cpus}|${specs.memMB}|${uplink}`;
  try {
    const saved = JSON.parse(await readFile(join(dir, 'bench.json'), 'utf8')) as { key: string; capacity: NodeCapacity };
    if (saved.key === key) return saved.capacity;
  } catch {
    /* none yet */
  }
  const declared = arg('matches');
  const capacity: NodeCapacity = declared
    ? { matches: Math.max(1, Math.min(200, parseInt(declared, 10) || 1)), cpuMsPerMatchSecond: 0, memMBPerMatch: 0, uplinkMbps: uplink, source: 'declared' }
    : await runBench({ uplinkMbps: uplink, log: (m) => console.log(m) });
  await writeFile(join(dir, 'bench.json'), JSON.stringify({ key, capacity }, null, 2));
  return capacity;
}

async function register(): Promise<void> {
  const control = (arg('control') ?? fail('--control <url> is required')).replace(/\/$/, '');
  const token = arg('token') ?? fail('--token is required');
  const dir = dataDir();
  await mkdir(dir, { recursive: true });
  try {
    await readFile(join(dir, 'node.json'));
    if (!process.argv.includes('--force')) fail(`${dir}/node.json exists: this machine is registered already (--force replaces it)`);
  } catch {
    /* fresh */
  }
  const roles = (arg('roles', 'host') as string).split(',').map((r) => r.trim()) as NodeRole[];
  const askedUrl = arg('public-url') ?? null;
  const transports = (arg('transport', askedUrl ? 'wss' : 'rtc') as string).split(',').map((t) => t.trim()) as NodeTransport[];
  if (transports.some((t) => t !== 'wss' && t !== 'rtc')) fail('--transport: wss, rtc or wss,rtc');
  const publicUrl = roles.includes('host') && transports.includes('wss') ? askedUrl ?? fail('--public-url wss://<public ip or name> is required for the wss transport') : null;
  const uplink = arg('uplink-mbps') ? Number(arg('uplink-mbps')) : null;
  const build = await buildId();
  const capacity = await capacityFor(dir, build, uplink);
  let id: NodeIdentityFile;
  try {
    id = await registerNode({ control, token, roles, transports: roles.includes('host') ? transports : [], publicUrl, name: arg('name'), build, specs: nodeSpecs(), capacity });
  } catch (e) {
    return fail(`registration refused: ${e instanceof Error ? e.message : String(e)}`);
  }
  const file = join(dir, 'node.json');
  await writeFile(file, JSON.stringify(id, null, 2));
  await chmod(file, 0o600).catch(() => undefined);
  console.log(`registered as ${id.name} (${id.nodeId}) in region ${id.region}. Next: turbogol-node run --data ${dir}`);
}

/** --rtc-ports 50000-50199: host candidates in a fixed UDP range (for a firewall or a port forward). */
function rtcPorts(): { portRange?: [number, number] } {
  const r = arg('rtc-ports');
  const m = r ? /^(\d{4,5})-(\d{4,5})$/.exec(r) : null;
  if (r && !m) fail('--rtc-ports <from>-<to>, e.g. 50000-50199');
  if (!m) return {};
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!(a >= 1024 && b <= 65535 && b > a)) fail('--rtc-ports: 1024 <= from < to <= 65535');
  return { portRange: [a, b] };
}

async function run(): Promise<void> {
  const dir = dataDir();
  const id = await readIdentity(dir);
  const build = await buildId();
  const uplink = arg('uplink-mbps') ? Number(arg('uplink-mbps')) : null;
  const capacity = await capacityFor(dir, build, uplink);
  const cap = arg('egress-cap-gb');
  const runtime = new NodeRuntime({
    identity: id,
    build,
    specs: nodeSpecs(),
    capacity,
    listenPort: Number(arg('port', '7350')),
    listenHost: arg('listen', '127.0.0.1') as string,
    dataDir: dir,
    egressCapGB: cap ? Number(cap) : null,
    rtc: rtcPorts(),
    onExit: (code) => {
      void runtime.stop().finally(() => process.exit(code));
    },
  });
  let interrupts = 0;
  let stoppingNow = false;
  const stopNow = (): void => {
    if (stoppingNow) return;
    stoppingNow = true;
    void runtime.stop().finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => runtime.requestStop());
  process.on('SIGINT', () => {
    // Drain also when the last match is over but its replay upload or report is still in flight:
    // stopping then would lose the report (a 'no_report' strike for an honest node).
    if (++interrupts === 1 && (runtime.rooms.size > 0 || runtime.agent.backlog > 0)) {
      console.log('draining (Ctrl+C again to stop now)');
      runtime.requestStop();
      return;
    }
    stopNow();
  });
  // The launcher (spawned with an 'ipc' stdio) asks over the IPC channel, which works on Windows
  // too, where a child gets no SIGTERM: { t: 'stop' } = SIGTERM, { t: 'stop-now' } = second Ctrl+C.
  const ipc = process as unknown as IpcProcess;
  if (typeof ipc.send === 'function') {
    ipc.on('message', (m) => {
      const t = m && typeof m === 'object' ? (m as { t?: unknown }).t : undefined;
      if (t === 'stop') runtime.requestStop();
      else if (t === 'stop-now') stopNow();
    });
    // Listening must not keep the process alive on its own (the runtime decides when to exit).
    ipc.channel?.unref();
  }
  await runtime.start();
}

/** The IPC side of `process` (types/node-shim.d.ts declares only what the rest of the package uses). */
interface IpcProcess {
  send?: (message: unknown) => boolean;
  channel?: { unref(): void };
  on(event: 'message', listener: (message: unknown) => void): unknown;
}

async function bench(): Promise<void> {
  const uplink = arg('uplink-mbps') ? Number(arg('uplink-mbps')) : null;
  const c = await runBench({ seconds: Number(arg('seconds', '5')), uplinkMbps: uplink, log: (m) => console.log(m) });
  console.log(JSON.stringify({ specs: nodeSpecs(), capacity: c }, null, 2));
}

async function verifyFile(): Promise<void> {
  const file = process.argv[3] ?? fail('verify <replay-file>');
  const build = await buildId();
  const v = await verifyReplay(new Uint8Array(await readFile(file)), { makeSim: nodeSimFactory, wasmSha256: build.wasmSha256, protocol: build.protocol });
  console.log(JSON.stringify(v, null, 2));
  process.exit(v.ok ? 0 : 1);
}

/**
 * rtc-test [--stun stun:host:port] [--turn turn:host:port --turn-user u --turn-pass p]: can players
 * reach this machine over WebRTC? Two peers connect through the given servers (relay-only through
 * TURN when one is given). Without options: host candidates only (proves the WebRTC stack works).
 */
async function rtcTest(): Promise<void> {
  const iceServers: Array<{ urls: string; username?: string; credential?: string }> = [];
  const stun = arg('stun');
  if (stun) iceServers.push({ urls: stun });
  const turn = arg('turn');
  if (turn) iceServers.push({ urls: turn, username: arg('turn-user'), credential: arg('turn-pass') });
  const r = await rtcSelfTest({ iceServers, ...rtcPorts() });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}

async function status(): Promise<void> {
  const id = await readIdentity(dataDir());
  const res = await fetch(`${id.httpBase}/nodes/status`);
  const s = (await res.json()) as { nodes: Array<{ name: string }> };
  console.log(JSON.stringify(s.nodes.find((n) => n.name === id.name) ?? { name: id.name, status: 'unknown' }, null, 2));
}

const cmd = process.argv[2];
const commands: Record<string, () => Promise<void>> = { register, run, bench, verify: verifyFile, status, 'rtc-test': rtcTest };
const fn = cmd ? commands[cmd] : undefined;
if (!fn) {
  console.log('usage: turbogol-node <register|run|bench|verify|status|rtc-test> [options]  (see node/main.ts)');
  process.exit(cmd ? 2 : 0);
} else {
  fn().catch((e) => fail(e instanceof Error ? e.message : String(e)));
}
