// The node release channel: channel.json in the R2 bucket turbogol-node-releases, served at
// /nodes/releases/channel. `stable` is the version launchers run; `minimum` the oldest one the
// control plane still gives matches to (older nodes are told to update). The deploy gate
// (scripts/node-release-gate.mjs at the repo root) moves it on every `npm run deploy` that needs it;
// this is the same move by hand, and the way back.
//
//   node scripts/channel.mjs --show
//   node scripts/channel.mjs --stable X.Y.Z [--minimum X.Y.Z]   (minimum: the current one by default)
//   node scripts/channel.mjs --rollback                         back to channel.prev.json
//
// Before writing, the stable release's manifest.json and manifest.sig must be in R2 and verify
// against nodes/release-key.pub. The current channel is saved as channel.prev.json first (so a
// rollback can be undone with another one), and the new one is read back. R2 goes through the
// wrangler locked in server/ (npm ci there first), always with --remote; the credentials are the
// ones `npm run deploy` uses (the environment, or server/.env).
//
// A node leaves its version only when it restarts, or when the control plane tells it to because it
// is below the minimum (when it connects, or within 60 s of a channel change). Lowering the channel
// does not bring back a node that already moved up: restart it.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findRepoRoot } from './repo-root.mjs';
import { readReleaseKey, verifyB64 } from './release-key.mjs';

export const BUCKET = 'turbogol-node-releases';
const JSON_TYPE = 'application/json';

const sha = (b) => createHash('sha256').update(b).digest('hex');

export class R2Error extends Error {}

/** Plain X.Y.Z: compareVersions (nodes/shared/controlProtocol.ts) mis-orders prerelease suffixes. */
export const isVersion = (v) => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v);

export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

const lastLines = (text) => text.trim().split('\n').slice(-12).join('\n');

/**
 * R2 through wrangler (`run(args)` -> { status, stdout, stderr }; by default the wrangler in
 * server/node_modules, never a global one or an npx download). Objects go through temporary files,
 * so wrangler's own output never mixes with them.
 */
export function wranglerR2({ server, env = process.env, run } = {}) {
  run ??= (args) => {
    const bin = join(server, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
    if (!existsSync(bin)) throw new R2Error(`no wrangler in ${join(server, 'node_modules')}: run npm ci in server/`);
    return spawnSync(process.execPath, [bin, ...args], { cwd: server, env, encoding: 'utf8' });
  };
  const call = (args) => {
    const r = run(args);
    return { ok: r.status === 0, text: `${r.stdout ?? ''}\n${r.stderr ?? ''}\n${r.error?.message ?? ''}` };
  };
  const withTemp = (fn) => {
    const dir = mkdtempSync(join(tmpdir(), 'tgn-r2-'));
    try {
      return fn(join(dir, 'object'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  return {
    /** The object's bytes, or null when wrangler finds nothing (a missing key, or a bucket that does not exist yet). */
    get(key) {
      return withTemp((file) => {
        const r = call(['r2', 'object', 'get', `${BUCKET}/${key}`, '--file', file, '--remote']);
        if (r.ok) return readFileSync(file);
        // Wrangler answers every 404 of the R2 API with this, the missing bucket's included.
        if (r.text.includes('The specified key does not exist')) return null;
        throw new R2Error(`could not read ${key} from R2:\n${lastLines(r.text)}`);
      });
    },
    put(key, bytes, contentType) {
      withTemp((file) => {
        writeFileSync(file, bytes);
        const r = call(['r2', 'object', 'put', `${BUCKET}/${key}`, '--file', file, '--content-type', contentType, '--remote']);
        if (!r.ok) throw new R2Error(`could not write ${key} to R2:\n${lastLines(r.text)}`);
      });
    },
  };
}

export function parseChannel(bytes) {
  let c;
  try {
    c = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    c = null;
  }
  if (!c || !isVersion(c.stable) || !isVersion(c.minimum)) throw new Error('channel.json is not { stable, minimum } with X.Y.Z versions');
  return { stable: c.stable, minimum: c.minimum };
}

/** The live channel, or null when there is none yet. */
export function readChannel(r2) {
  const b = r2.get('channel.json');
  return b ? parseChannel(b) : null;
}

/**
 * A published release, its signature checked: { version, manifest, inputs } (inputs: the repo files
 * node.mjs was built from, or null when the release has no verifiable list), or null when it is not
 * in R2.
 */
export function readRelease(r2, version, releaseKey) {
  if (!isVersion(version)) throw new Error(`bad version ${version}`);
  const manifestBytes = r2.get(`${version}/manifest.json`);
  if (!manifestBytes) return null;
  const sig = r2.get(`${version}/manifest.sig`);
  if (!sig) throw new Error(`release ${version} has a manifest.json but no manifest.sig`);
  if (!verifyB64(manifestBytes, sig.toString('utf8'), releaseKey.key)) throw new Error(`release ${version}: manifest.sig does not verify with nodes/release-key.pub`);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.name !== 'turbogol-node' || manifest.version !== version) throw new Error(`release ${version}: its manifest.json is not for ${version}`);
  // inputs.json is not signed itself: the signed manifest carries its hash.
  let inputs = null;
  const b = typeof manifest.inputsSha256 === 'string' ? r2.get(`${version}/inputs.json`) : null;
  if (b) {
    if (sha(b) !== manifest.inputsSha256) throw new Error(`release ${version}: inputs.json does not match its manifest`);
    const files = JSON.parse(b.toString('utf8')).files;
    if (Array.isArray(files) && files.every((f) => typeof f === 'string')) inputs = files;
  }
  return { version, manifest, inputs };
}

const describe = (c) => (c ? `stable ${c.stable}, minimum ${c.minimum}` : 'none');

/**
 * Point the channel at { stable, minimum } after checking the stable release; the old channel
 * becomes channel.prev.json. Returns the old channel (null if there was none).
 */
export function moveChannel(r2, next, releaseKey, log = console.log) {
  const { stable, minimum } = next;
  if (!isVersion(stable) || !isVersion(minimum)) throw new Error('stable and minimum must be X.Y.Z versions');
  if (compareVersions(minimum, stable) > 0) throw new Error(`minimum ${minimum} is above stable ${stable}`);
  if (!readRelease(r2, stable, releaseKey)) throw new Error(`release ${stable} is not in R2`);
  const before = r2.get('channel.json');
  let prev = null;
  if (before) {
    try {
      prev = parseChannel(before);
    } catch {
      /* a broken channel is still kept as channel.prev.json */
    }
    r2.put('channel.prev.json', before, JSON_TYPE);
  }
  r2.put('channel.json', Buffer.from(JSON.stringify({ stable, minimum }, null, 2)), JSON_TYPE);
  let back = null;
  try {
    back = readChannel(r2);
  } catch {
    /* reported below */
  }
  if (!back || back.stable !== stable || back.minimum !== minimum) throw new Error(`channel.json does not read back as stable ${stable}, minimum ${minimum}`);
  log(`channel: ${describe(prev)} -> ${describe(back)}${before ? ' (the old one is in channel.prev.json)' : ''}`);
  return prev;
}

/** Restore channel.prev.json (checked like any move; the channel it replaces becomes the new channel.prev.json). */
export function rollbackChannel(r2, releaseKey, log = console.log) {
  const b = r2.get('channel.prev.json');
  if (!b) throw new Error('there is no channel.prev.json to go back to');
  const prev = parseChannel(b);
  moveChannel(r2, prev, releaseKey, log);
  return prev;
}

/** Step two of every way back: a node that already moved up stays there until it restarts. */
export function restartAdvice(version) {
  return `drain or restart the node: the control plane only updates nodes below the minimum, so a node that already moved to ${version} stays there. On the VPS, \`sudo systemctl restart turbogol-node\` drains its matches and starts it again on the restored stable; a drain (POST /nodes/admin/drain) only stops it taking matches until that restart.`;
}

/** The deploy's credentials: the environment, then server/.env (as scripts/deploy.mjs reads it). */
function serverEnv(server) {
  const env = { ...process.env };
  const file = join(server, '.env');
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const nodes = join(dirname(fileURLToPath(import.meta.url)), '..');
    const server = join(findRepoRoot(nodes), 'server');
    const r2 = wranglerR2({ server, env: serverEnv(server) });
    const releaseKey = readReleaseKey(join(nodes, 'release-key.pub'));
    let current = null;
    try {
      current = readChannel(r2);
    } catch (e) {
      // A broken channel must not stop the command that fixes it.
      if (e instanceof R2Error) throw e;
      console.warn(`channel: the live channel.json is broken (${e.message})`);
    }
    if (process.argv.includes('--rollback')) {
      const from = current?.stable ?? 'the newer version';
      rollbackChannel(r2, releaseKey);
      console.log(`Then ${restartAdvice(from)}`);
    } else if (arg('stable')) {
      const stable = arg('stable');
      moveChannel(r2, { stable, minimum: arg('minimum') ?? current?.minimum ?? stable }, releaseKey);
      if (current && compareVersions(stable, current.stable) < 0) console.log(`Then ${restartAdvice(current.stable)}`);
    } else if (process.argv.includes('--show')) {
      console.log(`channel: ${describe(current)}`);
    } else {
      throw new Error('usage: channel.mjs --show | --stable X.Y.Z [--minimum X.Y.Z] | --rollback');
    }
  } catch (e) {
    console.error(`channel: ${e.message}`);
    process.exit(1);
  }
}
