// The node-release gate of `npm run deploy` (scripts/node-release-gate.mjs) and the channel tool
// (nodes/scripts/channel.mjs), against a throwaway git repo, throwaway release keys and a fake
// wrangler that keeps R2 in memory. Nothing here talks to Cloudflare.
//   node --test tests/deploy-gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gatedDeploy, gitRunner, rollbackAdvice } from '../scripts/node-release-gate.mjs';
import { BUCKET, moveChannel, readChannel, rollbackChannel, wranglerR2 } from '../nodes/scripts/channel.mjs';
import { rawOf, readReleaseKey, signB64 } from '../nodes/scripts/release-key.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');

function releaseKeyPair() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, raw: rawOf(privateKey) };
}

// The node inputs a release lists (what build-node.mjs writes to inputs.json: sources, lockfiles,
// the build configuration), and one file the node never runs.
const INPUTS = ['nodes/node/agent.ts', 'nodes/node/version.ts', 'nodes/package-lock.json', 'nodes/package.json', 'nodes/shared/controlProtocol.ts', 'package.json', 'server/src/roomHost.ts', 'src/game/Match.ts', 'src/net/protocol.ts', 'src/sim/wasm/rocketsim.wasm', 'tsconfig.json'];

/** A repo shaped like this one, as far as the gate looks, with origin/main at HEAD. */
function makeRepo(t, releaseRaw) {
  const dir = mkdtempSync(join(tmpdir(), 'tgn-gate-'));
  const home = mkdtempSync(join(tmpdir(), 'tgn-gate-home-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  // Nobody's own git config (signing, hooks, line endings) reaches the fixture.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(home, 'none'), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const repo = {
    dir,
    env,
    git,
    write(path, text) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    },
    /** Commit everything and merge it: origin/main follows. */
    commit(message) {
      git('add', '-A');
      git('commit', '-q', '--allow-empty', '-m', message);
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      return git('rev-parse', 'HEAD');
    },
    setVersion(v) {
      repo.write('nodes/package.json', JSON.stringify({ name: 'turbogol-community-nodes', version: v }, null, 2));
      repo.write('nodes/node/version.ts', `export const NODE_VERSION = '${v}';\n`);
    },
    wasmSha() {
      return sha(readFileSync(join(dir, 'src', 'sim', 'wasm', 'rocketsim.wasm')));
    },
  };
  git('init', '-q', '-b', 'main');
  repo.setVersion('0.2.0');
  repo.write('nodes/node/agent.ts', 'export const agent = 1;\n');
  repo.write('nodes/package-lock.json', '{}\n');
  repo.write('nodes/release-key.pub', `${releaseRaw}\n`);
  repo.write('nodes/shared/controlProtocol.ts', 'export const wire = 1;\n');
  repo.write('package.json', JSON.stringify({ name: 'turbogol', type: 'module', scripts: { build: 'vite build' } }, null, 2));
  repo.write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022' } }, null, 2));
  repo.write('src/net/protocol.ts', 'export const PROTOCOL_VERSION = 7;\n');
  repo.write('src/game/Match.ts', 'export const rules = 1;\n');
  repo.write('src/ui/menu.ts', 'export const menu = 1;\n');
  repo.write('src/sim/wasm/rocketsim.wasm', 'wasm-1');
  repo.write('server/src/roomHost.ts', 'export const host = 1;\n');
  repo.commit('first');
  return repo;
}

/** Publish a release into the fake bucket, as the release workflow would after build + sign. */
function publish(store, key, { version, commit, wasmSha256, protocol = 7, inputs = INPUTS }) {
  const inputsBytes = Buffer.from(JSON.stringify({ version, files: inputs }, null, 2));
  const manifest = { name: 'turbogol-node', version, protocol, wasmSha256, nodeMajor: 24, entry: 'node.mjs', createdAt: '2026-10-19T00:00:00Z', commit, inputsSha256: sha(inputsBytes), files: [{ path: 'node.mjs', sha256: 'a'.repeat(64), size: 1 }] };
  const mb = Buffer.from(JSON.stringify(manifest, null, 2));
  store.set(`${version}/manifest.json`, mb);
  store.set(`${version}/manifest.sig`, Buffer.from(signB64(mb, key.privateKey)));
  store.set(`${version}/inputs.json`, inputsBytes);
}

const channelOf = (store, name = 'channel.json') => (store.has(name) ? JSON.parse(store.get(name).toString('utf8')) : null);

/**
 * Wrangler's `r2 object get|put <bucket>/<key> --file <f> ... --remote` over a Map. `fail` makes every
 * call fail with that text (an auth error, say). Every call and every write lands in `events`.
 */
function fakeWrangler(store, events, { fail = null } = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const [, , op, path] = args;
    const key = path.slice(BUCKET.length + 1);
    const file = args[args.indexOf('--file') + 1];
    if (fail) return { status: 1, stdout: '', stderr: fail };
    if (op === 'get') {
      if (!store.has(key)) return { status: 1, stdout: '', stderr: '✘ [ERROR] The specified key does not exist.\n' };
      writeFileSync(file, store.get(key));
      return { status: 0, stdout: `Downloading "${key}" from "${BUCKET}".\nDownload complete.\n`, stderr: '' };
    }
    store.set(key, readFileSync(file));
    events.push(`put ${key} ${args[args.indexOf('--content-type') + 1]}`);
    return { status: 0, stdout: 'Upload complete.\n', stderr: '' };
  };
  return { run, calls };
}

/** One `npm run deploy` through the gate: what it printed, what it wrote and in which order. */
function deployOnce(repo, store, { nodesOff = false, deployStatus = 0, fail = null } = {}) {
  const events = [];
  const gitCalls = [];
  const realGit = gitRunner(repo.dir, repo.env);
  const git = (args) => {
    gitCalls.push(args);
    return args[0] === 'fetch' ? '' : realGit(args);
  };
  const wrangler = fakeWrangler(store, events, { fail });
  const out = [];
  const err = [];
  const status = gatedDeploy({
    repo: repo.dir,
    nodesOff,
    git,
    r2: wranglerR2({ run: wrangler.run }),
    deploy: () => {
      events.push('deploy');
      return deployStatus;
    },
    log: (m) => out.push(m),
    error: (m) => err.push(m),
  });
  // Every R2 call is against the real bucket (wrangler 4 defaults to a local one), every write typed.
  for (const args of wrangler.calls) assert.ok(args.includes('--remote'), args.join(' '));
  for (const args of wrangler.calls.filter((a) => a[2] === 'put')) assert.ok(args.includes('--content-type'), args.join(' '));
  // The gate never tags, pushes or commits.
  for (const args of gitCalls) assert.ok(!['tag', 'push', 'commit'].includes(args[0]), args.join(' '));
  return { status, events, out: out.join('\n'), err: err.join('\n') };
}

/** A repo with release 0.2.0 published from its first commit and the channel on it. */
function live(t) {
  const key = releaseKeyPair();
  const repo = makeRepo(t, key.raw);
  const store = new Map();
  const first = repo.commit('nothing new');
  publish(store, key, { version: '0.2.0', commit: first, wasmSha256: repo.wasmSha() });
  store.set('channel.json', Buffer.from(JSON.stringify({ stable: '0.2.0', minimum: '0.2.0' })));
  return { key, repo, store };
}

test('a build whose game code the live release already runs deploys without touching the channel', (t) => {
  const { repo, store } = live(t);
  repo.write('src/ui/menu.ts', 'export const menu = 2;\n'); // not something nodes run
  repo.commit('menu change');
  const r = deployOnce(repo, store);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.events, ['deploy']);
  assert.deepEqual(channelOf(store), { stable: '0.2.0', minimum: '0.2.0' });
});

test('a change to the node program alone needs no release; when one is published, only stable moves', (t) => {
  const { key, repo, store } = live(t);
  repo.write('nodes/node/agent.ts', 'export const agent = 2;\n');
  repo.setVersion('0.2.1');
  const c = repo.commit('agent fix');
  let r = deployOnce(repo, store);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.events, ['deploy'], 'nodes on 0.2.0 still run this game');

  publish(store, key, { version: '0.2.1', commit: c, wasmSha256: repo.wasmSha() });
  r = deployOnce(repo, store);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.events, ['put channel.prev.json application/json', 'put channel.json application/json', 'deploy']);
  assert.deepEqual(channelOf(store), { stable: '0.2.1', minimum: '0.2.0' });
  assert.match(r.out, /next restart/);
});

test('game JavaScript the nodes run changed: stable AND minimum move to the release of this build, before the deploy', (t) => {
  const { key, repo, store } = live(t);
  // Same wasm, same protocol: placement alone (sameBuild) would keep nodes on the old rules.
  repo.write('src/game/Match.ts', 'export const rules = 2;\n');
  repo.setVersion('0.2.1');
  const c = repo.commit('new rules');
  publish(store, key, { version: '0.2.1', commit: c, wasmSha256: repo.wasmSha() });
  const r = deployOnce(repo, store);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.events, ['put channel.prev.json application/json', 'put channel.json application/json', 'deploy']);
  assert.deepEqual(channelOf(store), { stable: '0.2.1', minimum: '0.2.1' });
  assert.deepEqual(channelOf(store, 'channel.prev.json'), { stable: '0.2.0', minimum: '0.2.0' });
  assert.match(r.out, /src\/game\/Match\.ts/);
  assert.match(r.out, /within 60 s/);
});

test('a wasm change without its release aborts before anything is written', (t) => {
  const { repo, store } = live(t);
  repo.write('src/sim/wasm/rocketsim.wasm', 'wasm-2');
  repo.setVersion('0.2.1');
  repo.commit('new wasm');
  const r = deployOnce(repo, store);
  assert.equal(r.status, 1);
  assert.deepEqual(r.events, []);
  assert.match(r.err, /release 0\.2\.1 is not published.*node-v0\.2\.1/s);
  assert.match(r.err, /--nodes-off/, 'another wasm: --nodes-off is a way out');
  assert.deepEqual(channelOf(store), { stable: '0.2.0', minimum: '0.2.0' });
});

test('a release built from other game code aborts', (t) => {
  const { key, repo, store } = live(t);
  repo.write('server/src/roomHost.ts', 'export const host = 2;\n');
  repo.setVersion('0.2.1');
  const tagged = repo.commit('host change, tagged');
  publish(store, key, { version: '0.2.1', commit: tagged, wasmSha256: repo.wasmSha() });
  repo.write('src/game/Match.ts', 'export const rules = 2;\n'); // merged after the tag
  repo.commit('rules change after the release');
  const r = deployOnce(repo, store);
  assert.equal(r.status, 1);
  assert.deepEqual(r.events, []);
  assert.match(r.err, /release 0\.2\.1 is not this build \(game code: src\/game\/Match\.ts\)/);
});

test('game code changed but the version is still the live one: asks for a bump', (t) => {
  const { repo, store } = live(t);
  repo.write('src/game/Match.ts', 'export const rules = 2;\n');
  repo.commit('rules change, no bump');
  const r = deployOnce(repo, store);
  assert.equal(r.status, 1);
  assert.match(r.err, /still at 0\.2\.0: raise it above 0\.2\.0/);
});

test('--nodes-off deploys without the release only when nodes cannot get matches from this build', (t) => {
  const { repo, store } = live(t);
  // Same wasm and protocol, other rules: nodes would keep hosting the old game. Refused.
  repo.write('src/game/Match.ts', 'export const rules = 2;\n');
  repo.setVersion('0.2.1');
  repo.commit('rules change');
  let r = deployOnce(repo, store, { nodesOff: true });
  assert.equal(r.status, 1);
  assert.deepEqual(r.events, []);
  assert.match(r.err, /--nodes-off cannot keep nodes away from this build/);

  // Another wasm: no node on 0.2.0 matches this build, so nodes simply get no matches.
  repo.write('src/sim/wasm/rocketsim.wasm', 'wasm-2');
  repo.commit('new wasm');
  r = deployOnce(repo, store, { nodesOff: true });
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.events, ['deploy']);
  assert.deepEqual(channelOf(store), { stable: '0.2.0', minimum: '0.2.0' });
});

test('first deploy: without a channel (or a bucket), --nodes-off is required until the release; then the release becomes the channel', (t) => {
  const key = releaseKeyPair();
  const repo = makeRepo(t, key.raw);
  const store = new Map(); // wrangler answers a missing bucket like a missing key
  let r = deployOnce(repo, store);
  assert.equal(r.status, 1);
  assert.deepEqual(r.events, []);
  assert.match(r.err, /no node release channel yet.*every deploy needs --nodes-off/s);

  r = deployOnce(repo, store, { nodesOff: true });
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.events, ['deploy']);
  assert.equal(store.has('channel.json'), false);

  const head = repo.commit('nothing new');
  publish(store, key, { version: '0.2.0', commit: head, wasmSha256: repo.wasmSha() });
  r = deployOnce(repo, store);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.events, ['put channel.json application/json', 'deploy']);
  assert.deepEqual(channelOf(store), { stable: '0.2.0', minimum: '0.2.0' });
});

test('an R2 error other than "not found" stops the deploy, --nodes-off or not', (t) => {
  const { repo, store } = live(t);
  for (const nodesOff of [false, true]) {
    const r = deployOnce(repo, store, { nodesOff, fail: '✘ [ERROR] A request to the Cloudflare API failed. Authentication error [code: 10000]' });
    assert.equal(r.status, 1);
    assert.deepEqual(r.events, []);
    assert.match(r.err, /could not read channel\.json from R2.*Authentication error/s);
  }
});

test('a release signed by another key is refused', (t) => {
  const { repo, store } = live(t);
  repo.write('src/game/Match.ts', 'export const rules = 2;\n');
  repo.setVersion('0.2.1');
  const c = repo.commit('new rules');
  publish(store, releaseKeyPair(), { version: '0.2.1', commit: c, wasmSha256: repo.wasmSha() });
  const r = deployOnce(repo, store);
  assert.equal(r.status, 1);
  assert.match(r.err, /manifest\.sig does not verify/);
  assert.deepEqual(channelOf(store), { stable: '0.2.0', minimum: '0.2.0' });
});

test('uncommitted changes anywhere in the tree, or a HEAD that is not origin/main, stop the deploy', (t) => {
  const { repo, store } = live(t);
  // Nothing nodes run, but the Worker serves what vite copies from public/.
  repo.write('public/robots.txt', 'User-agent: *\n');
  let r = deployOnce(repo, store);
  assert.equal(r.status, 1);
  assert.match(r.err, /uncommitted changes[^\n]*\n\?\? public\//);
  rmSync(join(repo.dir, 'public'), { recursive: true });
  repo.write('server/src/roomHost.ts', 'export const host = 3;\n');
  r = deployOnce(repo, store);
  assert.equal(r.status, 1);
  assert.match(r.err, /uncommitted changes/);
  spawnSync('git', ['commit', '-qam', 'local only'], { cwd: repo.dir, env: repo.env });
  r = deployOnce(repo, store);
  assert.equal(r.status, 1);
  assert.match(r.err, /is not origin\/main/);
  assert.deepEqual(r.events, []);
});

test('a deploy that fails after the channel moved prints the way back: restore channel.prev.json, then drain or restart the node', (t) => {
  const { key, repo, store } = live(t);
  repo.write('src/game/Match.ts', 'export const rules = 2;\n');
  repo.setVersion('0.2.1');
  const c = repo.commit('new rules');
  publish(store, key, { version: '0.2.1', commit: c, wasmSha256: repo.wasmSha() });
  const r = deployOnce(repo, store, { deployStatus: 1 });
  assert.equal(r.status, 1);
  assert.deepEqual(r.events, ['put channel.prev.json application/json', 'put channel.json application/json', 'deploy']);
  // Wrangler may have failed after the new build went live: check before going back.
  assert.match(r.err, /First see which build serves: {2}cd server; npx wrangler deployments status/);
  assert.doesNotMatch(r.err, /the Worker still runs the previous build/);
  assert.match(r.err, /channel\.mjs --rollback.*channel\.prev\.json: stable 0\.2\.0, minimum 0\.2\.0/);
  assert.match(r.err, /drain or restart the node/);
  assert.match(r.err, /systemctl restart turbogol-node/);

  // The printed rollback works, and once the deploy is fixed, the next one leaves the channel alone.
  const events = [];
  rollbackChannel(wranglerR2({ run: fakeWrangler(store, events).run }), readReleaseKey(join(repo.dir, 'nodes', 'release-key.pub')), () => {});
  assert.deepEqual(channelOf(store), { stable: '0.2.0', minimum: '0.2.0' });
  assert.deepEqual(channelOf(store, 'channel.prev.json'), { stable: '0.2.1', minimum: '0.2.1' });
});

test('channel.mjs: a move needs a signed release and minimum <= stable, and reads back what it wrote', (t) => {
  const { key, repo, store } = live(t);
  const r2 = wranglerR2({ run: fakeWrangler(store, []).run });
  const releaseKey = readReleaseKey(join(repo.dir, 'nodes', 'release-key.pub'));
  assert.throws(() => moveChannel(r2, { stable: '0.3.0', minimum: '0.3.0' }, releaseKey, () => {}), /release 0\.3\.0 is not in R2/);
  assert.throws(() => moveChannel(r2, { stable: '0.2.0', minimum: '0.2.1' }, releaseKey, () => {}), /above stable/);
  publish(store, key, { version: '0.2.1', commit: repo.commit('x'), wasmSha256: repo.wasmSha() });
  const prev = moveChannel(r2, { stable: '0.2.1', minimum: '0.2.0' }, releaseKey, () => {});
  assert.deepEqual(prev, { stable: '0.2.0', minimum: '0.2.0' });
  assert.deepEqual(readChannel(r2), { stable: '0.2.1', minimum: '0.2.0' });
  // Tampered input list: its hash is in the signed manifest.
  store.set('0.2.1/inputs.json', Buffer.from('{"version":"0.2.1","files":[]}'));
  assert.throws(() => moveChannel(r2, { stable: '0.2.1', minimum: '0.2.1' }, releaseKey, () => {}), /inputs\.json does not match/);
});

test('the way back from a first channel pastes into Windows PowerShell 5.1 too (no &&)', () => {
  const advice = rollbackAdvice({ stable: '0.2.0', minimum: '0.2.0' }, null);
  assert.match(advice, /there was no channel before: remove it with {2}cd server; npx wrangler r2 object delete turbogol-node-releases\/channel\.json --remote; cd \.\./);
  assert.match(advice, /wrangler deployments status/);
  assert.ok(!advice.includes('&&'), advice);
});

test('a minimum kept below stable by hand is checked too: when its release runs other game code, it moves up', (t) => {
  const { key, repo, store } = live(t);
  repo.write('src/game/Match.ts', 'export const rules = 2;\n');
  repo.setVersion('0.2.1');
  const c = repo.commit('new rules');
  publish(store, key, { version: '0.2.1', commit: c, wasmSha256: repo.wasmSha() });
  // channel.mjs --stable 0.2.1 --minimum 0.2.0: nodes still on 0.2.0 keep the old rules and get matches.
  moveChannel(wranglerR2({ run: fakeWrangler(store, []).run }), { stable: '0.2.1', minimum: '0.2.0' }, readReleaseKey(join(repo.dir, 'nodes', 'release-key.pub')), () => {});
  const r = deployOnce(repo, store);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.events, ['put channel.prev.json application/json', 'put channel.json application/json', 'deploy']);
  assert.deepEqual(channelOf(store), { stable: '0.2.1', minimum: '0.2.1' });
  assert.match(r.out, /nodes on the minimum, 0\.2\.0, run other game code \(game code: src\/game\/Match\.ts\), so the minimum moves up to 0\.2\.1/);
  assert.match(r.out, /tells nodes below 0\.2\.1 to update/);
});

test('--nodes-off counts both ends of the channel: an old minimum on this wasm would still host it with old rules', (t) => {
  const { key, repo, store } = live(t);
  repo.write('src/sim/wasm/rocketsim.wasm', 'wasm-2');
  repo.setVersion('0.2.1');
  const c = repo.commit('new wasm');
  publish(store, key, { version: '0.2.1', commit: c, wasmSha256: repo.wasmSha() });
  moveChannel(wranglerR2({ run: fakeWrangler(store, []).run }), { stable: '0.2.1', minimum: '0.2.0' }, readReleaseKey(join(repo.dir, 'nodes', 'release-key.pub')), () => {});
  // Back to the first wasm, with new rules: nodes on 0.2.1 cannot host this build, nodes on 0.2.0 can.
  repo.write('src/sim/wasm/rocketsim.wasm', 'wasm-1');
  repo.write('src/game/Match.ts', 'export const rules = 2;\n');
  repo.setVersion('0.2.2');
  repo.commit('first wasm again, new rules');
  const r = deployOnce(repo, store, { nodesOff: true });
  assert.equal(r.status, 1);
  assert.deepEqual(r.events, []);
  assert.match(r.err, /--nodes-off cannot keep nodes away from this build: nodes on 0\.2\.0 would still get its matches/);
});

test('a release built from a commit that never reached main does not move the channel, even with the same game code', (t) => {
  const { key, repo, store } = live(t);
  repo.git('checkout', '-q', '-b', 'side');
  repo.write('nodes/node/agent.ts', 'export const agent = "never reviewed";\n');
  repo.setVersion('0.2.1');
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'unmerged agent');
  const side = repo.git('rev-parse', 'HEAD');
  repo.git('checkout', '-q', 'main');
  publish(store, key, { version: '0.2.1', commit: side, wasmSha256: repo.wasmSha() });
  repo.setVersion('0.2.1');
  repo.commit('version bump on main');
  const r = deployOnce(repo, store);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.events, ['deploy']);
  assert.deepEqual(channelOf(store), { stable: '0.2.0', minimum: '0.2.0' });
  assert.match(r.out, /release 0\.2\.1 is not this build \(unmerged code \(its commit [0-9a-f]{12} is not in main's history\)\), so stable does not move to it/);
});

test('nodes/shared counts as game code: the control plane on the other end of the wire is the Worker, so the minimum moves', (t) => {
  const { key, repo, store } = live(t);
  repo.write('nodes/shared/controlProtocol.ts', 'export const wire = 2;\n');
  repo.setVersion('0.2.1');
  const c = repo.commit('wire change');
  let r = deployOnce(repo, store);
  assert.equal(r.status, 1);
  assert.match(r.err, /game code: nodes\/shared\/controlProtocol\.ts/);
  publish(store, key, { version: '0.2.1', commit: c, wasmSha256: repo.wasmSha() });
  r = deployOnce(repo, store);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(channelOf(store), { stable: '0.2.1', minimum: '0.2.1' });
});

test('the build configuration counts: tsconfig.json whole, package.json by the fields esbuild reads', (t) => {
  const { repo, store } = live(t);
  // A script and a dependency range never reach the bundle.
  repo.write('package.json', JSON.stringify({ name: 'turbogol', type: 'module', scripts: { build: 'vite build', deploy: 'node scripts/deploy.mjs' }, devDependencies: { vite: '^9.0.0' } }, null, 2));
  repo.commit('new script');
  let r = deployOnce(repo, store);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.events, ['deploy']);

  repo.write('package.json', JSON.stringify({ name: 'turbogol', type: 'commonjs' }, null, 2));
  repo.commit('module type');
  r = deployOnce(repo, store);
  assert.equal(r.status, 1);
  assert.match(r.err, /game code: package\.json/);

  repo.write('package.json', JSON.stringify({ name: 'turbogol', type: 'module' }, null, 2));
  repo.write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2020' } }, null, 2));
  repo.commit('older target');
  r = deployOnce(repo, store);
  assert.equal(r.status, 1);
  assert.match(r.err, /game code: tsconfig\.json/);
});
