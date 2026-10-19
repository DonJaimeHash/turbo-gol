// The node-release gate of `npm run deploy` (scripts/deploy.mjs runs it before `wrangler deploy`).
//
// Community nodes run the game's own code: node.mjs bundles the match rules, the bots, the sim glue
// and server/src/roomHost.ts, next to the wasm. The control plane picks nodes by wasm and protocol
// only (nodes/shared/controlProtocol.ts, sameBuild), so a Worker deploy that changes any of that code
// without the nodes following leaves them hosting matches with other rules. Before every deploy:
//   1. The tree is clean (src server nodes scripts package.json package-lock.json) and HEAD is
//      origin/main, so the commit names exactly what is deployed.
//   2. The local build: the node version in nodes/package.json (the target release), the protocol,
//      the wasm's sha256.
//   3. The live state, from R2 through wrangler (--remote): channel.json and its stable release,
//      checked against nodes/release-key.pub, with the commit and the input list (inputs.json) it
//      was built from.
//   4. The game code nodes run: the live release's inputs outside nodes/, the wasm and the protocol.
//      Unchanged since that release's commit: deploy, and leave the channel alone; when this
//      commit's version is already published from the same game code, only stable moves to it (a
//      node-program fix: each node picks it up at its next restart).
//   5. Changed: the target release must be published, signed, and built from this commit's game
//      code. The channel then moves to stable = minimum = target BEFORE the deploy: the control
//      plane re-reads it within 60 s and tells every node below the minimum to update, and the
//      deploy drops the node connections, so each node is checked again when it reconnects. No such
//      release: abort; --nodes-off deploys anyway only when the nodes cannot get matches from this
//      build (another wasm or protocol), never when they would host it with old rules.
//   No channel yet (nothing published, or no bucket yet): a target release built from this commit's
//   game code becomes the first channel; otherwise every deploy needs --nodes-off.
// When the deploy fails after the channel moved, it prints the way back: restore channel.prev.json,
// then drain or restart the node. It never creates tags.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareVersions, isVersion, moveChannel, readChannel, readRelease, restartAdvice } from '../nodes/scripts/channel.mjs';
import { readReleaseKey } from '../nodes/scripts/release-key.mjs';

export const CLEAN_PATHS = ['src', 'server', 'nodes', 'scripts', 'package.json', 'package-lock.json'];
/** Inputs under nodes/ are the node program itself (agent, launcher, runtime, its dependencies): the Worker and the players never run them. */
const NODE_PROGRAM = 'nodes/';
const WASM = 'src/sim/wasm/rocketsim.wasm';

export class GateError extends Error {}

const sha = (b) => createHash('sha256').update(b).digest('hex');
const some = (files) => (files.length > 4 ? `${files.slice(0, 4).join(', ')} and ${files.length - 4} more` : files.join(', '));

/** git in the repo: `git(args)` -> stdout, a GateError when it fails. */
export function gitRunner(repo, env = process.env) {
  return (args) => {
    const r = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    if (r.status !== 0) throw new GateError(`git ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.error?.message || '').trim()}`);
    return r.stdout;
  };
}

/** What this checkout builds: { version, protocol, wasmSha256 }. */
export function localBuild(repo) {
  const pkg = JSON.parse(readFileSync(join(repo, 'nodes', 'package.json'), 'utf8'));
  const version = /NODE_VERSION = '([^']+)'/.exec(readFileSync(join(repo, 'nodes', 'node', 'version.ts'), 'utf8'))?.[1];
  if (version !== pkg.version) throw new GateError(`nodes/node/version.ts (${version}) and nodes/package.json (${pkg.version}) differ`);
  if (!isVersion(version)) throw new GateError(`nodes/package.json: ${version} is not a plain X.Y.Z version`);
  const protocol = Number(/PROTOCOL_VERSION = (\d+)/.exec(readFileSync(join(repo, 'src', 'net', 'protocol.ts'), 'utf8'))?.[1]);
  if (!Number.isInteger(protocol)) throw new GateError('no PROTOCOL_VERSION in src/net/protocol.ts');
  const wasmSha256 = sha(readFileSync(join(repo, WASM)));
  // The Worker announces this constant as its build, and nodes are matched against it: a stale one
  // would give nodes no matches at all.
  const constant = join(repo, 'src', 'sim', 'wasm', 'rocketsim.sha256.ts');
  if (existsSync(constant) && /[0-9a-f]{64}/.exec(readFileSync(constant, 'utf8'))?.[0] !== wasmSha256) throw new GateError(`src/sim/wasm/rocketsim.sha256.ts is not the sha256 of rocketsim.wasm (${wasmSha256})`);
  return { version, protocol, wasmSha256 };
}

/**
 * Decide what the deploy does to the channel: { move: { stable, minimum } | null, live, releaseKey }.
 * Reads only; throws a GateError when the deploy must not go ahead.
 */
export function checkNodeRelease({ repo, nodesOff = false, git, r2, log = console.log }) {
  git(['fetch', '--quiet', 'origin', 'main']);
  const dirty = git(['status', '--porcelain', '--', ...CLEAN_PATHS]).trim();
  if (dirty) throw new GateError(`uncommitted changes (deploy a commit of main):\n${dirty.split('\n').slice(0, 10).join('\n')}`);
  const head = git(['rev-parse', 'HEAD']).trim();
  const main = git(['rev-parse', 'refs/remotes/origin/main']).trim();
  if (head !== main) throw new GateError(`HEAD (${head.slice(0, 12)}) is not origin/main (${main.slice(0, 12)}): deploy main as it was merged`);

  const local = localBuild(repo);
  const releaseKey = readReleaseKey(join(repo, 'nodes', 'release-key.pub'));
  const target = local.version;

  /** Game files that differ between `commit` and HEAD, among a release's inputs. */
  const changedGame = (commit, inputs) => {
    try {
      git(['rev-parse', '--verify', '--quiet', `${commit}^{commit}`]);
    } catch {
      throw new GateError(`commit ${commit} is not in this clone: git fetch origin, then deploy again`);
    }
    const game = inputs.filter((p) => !p.startsWith(NODE_PROGRAM));
    if (game.length === 0) return [];
    return git(['--literal-pathspecs', 'diff', '--name-only', commit, 'HEAD', '--', ...game])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  };
  /** How a release's game code differs from this build ([] = it runs exactly this game). */
  const differences = (release) => {
    const m = release.manifest;
    const out = [];
    const wasm = m.wasmSha256 !== local.wasmSha256;
    if (wasm) out.push('the wasm');
    if (m.protocol !== local.protocol) out.push(`the protocol (${m.protocol}, here ${local.protocol})`);
    if (!/^[0-9a-f]{40}$/.test(m.commit ?? '') || !release.inputs) out.push('unknown game code (the release names no commit or input list)');
    else {
      const files = changedGame(m.commit, release.inputs).filter((f) => !(wasm && f === WASM));
      if (files.length > 0) out.push(`game code: ${some(files)}`);
    }
    return out;
  };
  let targetRelease;
  const getTarget = () => (targetRelease === undefined ? (targetRelease = readRelease(r2, target, releaseKey)) : targetRelease);

  const channel = readChannel(r2);
  if (!channel) {
    const t = getTarget();
    const diff = t ? differences(t) : null;
    if (t && diff.length === 0) {
      log(`node release gate: no channel yet; release ${target} was built from this game code and becomes the first channel`);
      return { move: { stable: target, minimum: target }, live: null, releaseKey };
    }
    const reason = t ? `release ${target} is not this build (${diff.join('; ')})` : `release ${target} is not published`;
    if (nodesOff) {
      log(`node release gate: no channel yet and ${reason}; deploying with --nodes-off: nodes get no matches until a release of this game code is published and a deploy moves the channel`);
      return { move: null, live: null, releaseKey };
    }
    throw new GateError(`no node release channel yet, and ${reason}. Until the first release, every deploy needs --nodes-off (npm run deploy -- --nodes-off); or publish release ${target} from this commit (tag node-v${target}) and deploy again`);
  }

  const live = readRelease(r2, channel.stable, releaseKey);
  if (!live) throw new GateError(`channel.json points to ${channel.stable}, which is not in R2: fix the channel first (node nodes/scripts/channel.mjs --stable <a published version>)`);
  const liveDiff = differences(live);
  const newer = compareVersions(target, channel.stable) > 0;
  if (liveDiff.length === 0) {
    const t = newer ? getTarget() : null;
    if (t && differences(t).length === 0) {
      log(`node release gate: the game code nodes run is unchanged; release ${target} only changes the node program, so stable moves to it (each node picks it up at its next restart) and minimum stays ${channel.minimum}`);
      return { move: { stable: target, minimum: channel.minimum }, live: channel, releaseKey };
    }
    log(`node release gate: nodes on ${channel.stable} run this build's game code; the channel stays at stable ${channel.stable}, minimum ${channel.minimum}`);
    return { move: null, live: channel, releaseKey };
  }

  // The game code changed: nodes must run a release built from it as soon as this build is live.
  const t = newer ? getTarget() : null;
  const targetDiff = t ? differences(t) : null;
  if (t && targetDiff.length === 0) {
    log(`node release gate: the game code nodes run changed since ${channel.stable} (${liveDiff.join('; ')}); release ${target} is this build, so stable and minimum move to it`);
    return { move: { stable: target, minimum: target }, live: channel, releaseKey };
  }
  const need = !newer
    ? `nodes/package.json is still at ${target}: raise it above ${channel.stable} and publish that release from this commit`
    : t
      ? `release ${target} is not this build (${targetDiff.join('; ')}): publish a new version from this commit`
      : `release ${target} is not published: tag node-v${target} at this commit and approve the release run`;
  // Nodes on another wasm or protocol get no matches from this build; on the same ones they would.
  const unplaceable = live.manifest.wasmSha256 !== local.wasmSha256 || live.manifest.protocol !== local.protocol;
  if (nodesOff && unplaceable) {
    log(`node release gate: --nodes-off; nodes stay on ${channel.stable}, whose wasm or protocol differs from this build, so they get no matches until a release of it moves the channel`);
    return { move: null, live: channel, releaseKey };
  }
  if (nodesOff) throw new GateError(`--nodes-off cannot keep nodes away from this build: ${channel.stable} has the same wasm and protocol, so the control plane would keep giving matches to nodes running other game code (${liveDiff.join('; ')}). Instead: ${need}, then deploy again`);
  throw new GateError(`the game code nodes run changed since ${channel.stable} (${liveDiff.join('; ')}), and ${need}, then deploy again${unplaceable ? '. Or deploy with --nodes-off: nodes then get no matches until that release' : ''}`);
}

/** The way back when the deploy fails after the channel moved (the Worker still runs the previous build). */
export function rollbackAdvice(move, prev) {
  const first = prev
    ? `node nodes/scripts/channel.mjs --rollback   (restores channel.prev.json: stable ${prev.stable}, minimum ${prev.minimum})`
    : `there was no channel before: remove it with  cd server && npx wrangler r2 object delete turbogol-node-releases/channel.json --remote`;
  return [
    `the deploy failed, but the channel already moved to stable ${move.stable}, minimum ${move.minimum}, and the Worker still runs the previous build. To go back:`,
    `  1. ${first}`,
    `  2. Then ${restartAdvice(move.stable)}`,
    'Or fix the deploy and run it again: the channel already matches this build.',
  ].join('\n');
}

/**
 * The whole deploy: the gate, the channel move, then `deploy()` (-> exit status). Returns the exit
 * status for scripts/deploy.mjs.
 */
export function gatedDeploy({ repo, nodesOff = false, git, r2, deploy, log = console.log, error = console.error }) {
  let plan;
  try {
    plan = checkNodeRelease({ repo, nodesOff, git, r2, log });
  } catch (e) {
    error(`deploy stopped: ${e.message}`);
    return 1;
  }
  let prev = null;
  if (plan.move) {
    try {
      prev = moveChannel(r2, plan.move, plan.releaseKey, log);
    } catch (e) {
      error(`deploy stopped: moving the channel failed: ${e.message}\nCheck it with node nodes/scripts/channel.mjs --show (node nodes/scripts/channel.mjs --rollback restores channel.prev.json)`);
      return 1;
    }
    log(
      plan.move.minimum !== plan.live?.minimum
        ? `the control plane re-reads the channel within 60 s and tells nodes below ${plan.move.minimum} to update; the deploy also drops their connections, and each one is checked again when it reconnects`
        : `nodes keep running and pick up ${plan.move.stable} at their next restart`,
    );
  }
  const status = deploy();
  if (status !== 0 && plan.move) error(rollbackAdvice(plan.move, prev));
  return status;
}
