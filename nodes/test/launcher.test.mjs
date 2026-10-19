// The launcher only installs what the release key signed, checks every file, and rolls back a
// version that keeps crashing. A stop request (SIGTERM / SIGINT / <data>/stop.request) reaches the
// node over IPC and ends the launcher, whatever the node's exit code.
import '../dev/ts-resolve.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const L = await import('../node/launcher.ts');
const { generateEd25519, importPrivateKey, sign, sha256Hex } = await import('../shared/edcrypto.ts');

const enc = new TextEncoder();

async function makeRelease(version, key, files) {
  const list = [];
  for (const [path, bytes] of Object.entries(files)) list.push({ path, sha256: await sha256Hex(bytes), size: bytes.length });
  const manifest = { name: 'turbogol-node', version, protocol: 1, wasmSha256: list[1]?.sha256 ?? 'x', nodeMajor: 24, entry: 'node.mjs', createdAt: '2026-10-15T00:00:00Z', files: list };
  const mb = enc.encode(JSON.stringify(manifest));
  return { manifest, mb, sig: await sign(key, mb), files };
}

function fetcherFor(control, releases, channel) {
  const map = new Map();
  map.set(`${control}/nodes/releases/channel`, enc.encode(JSON.stringify(channel)));
  for (const r of releases) {
    const base = `${control}/nodes/releases/${r.manifest.version}`;
    map.set(`${base}/manifest.json`, r.mb);
    map.set(`${base}/manifest.sig`, enc.encode(r.sig));
    for (const [p, b] of Object.entries(r.files)) map.set(`${base}/${p}`, b);
  }
  return {
    map,
    bytes: async (u) => {
      if (!map.has(u)) throw new Error('404 ' + u);
      return map.get(u);
    },
    json: async (u) => JSON.parse(new TextDecoder().decode(map.get(u))),
  };
}

test('ensureRelease: verified download, cached reuse, tampering and wrong keys refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tgn-launcher-'));
  try {
    const rk = await generateEd25519();
    const key = await importPrivateKey(rk.privateKey);
    const files = { 'node.mjs': enc.encode('console.log("node")'), 'rocketsim.wasm': new Uint8Array([0, 97, 115, 109, 1]) };
    const r1 = await makeRelease('1.2.0', key, files);
    const f = fetcherFor('https://cp', [r1], { stable: '1.2.0', minimum: '1.0.0' });
    const m = await L.ensureRelease('https://cp', dir, '1.2.0', rk.publicKey, f);
    assert.equal(m.version, '1.2.0');
    assert.equal(await readFile(join(dir, 'releases', '1.2.0', 'node.mjs'), 'utf8'), 'console.log("node")');
    // Cached: works offline.
    const offline = { bytes: async () => assert.fail('no network needed'), json: async () => assert.fail('no network needed') };
    assert.equal((await L.ensureRelease('https://cp', dir, '1.2.0', rk.publicKey, offline)).version, '1.2.0');
    // A damaged local file is re-downloaded.
    await writeFile(join(dir, 'releases', '1.2.0', 'node.mjs'), 'evil()');
    await L.ensureRelease('https://cp', dir, '1.2.0', rk.publicKey, f);
    assert.equal(await readFile(join(dir, 'releases', '1.2.0', 'node.mjs'), 'utf8'), 'console.log("node")');

    // A file swapped on the server after signing.
    const r2 = await makeRelease('1.3.0', key, files);
    const f2 = fetcherFor('https://cp', [r2], { stable: '1.3.0', minimum: '1.0.0' });
    f2.map.set('https://cp/nodes/releases/1.3.0/node.mjs', enc.encode('evil()'));
    await assert.rejects(L.ensureRelease('https://cp', dir, '1.3.0', rk.publicKey, f2), /size|sha256/);
    // A manifest signed by someone else.
    const other = await generateEd25519();
    const r3 = await makeRelease('1.4.0', await importPrivateKey(other.privateKey), files);
    await assert.rejects(L.ensureRelease('https://cp', dir, '1.4.0', rk.publicKey, fetcherFor('https://cp', [r3], { stable: '1.4.0', minimum: '1.0.0' })), /signature/);
    // Path tricks in the manifest.
    const bad = { ...r1.manifest, version: '1.5.0', files: [{ path: '../../etc/passwd', sha256: 'a'.repeat(64), size: 1 }], entry: '../../etc/passwd' };
    const mb = enc.encode(JSON.stringify(bad));
    await assert.rejects(L.verifyManifest(mb, await sign(key, mb), rk.publicKey), /bad manifest entry/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('crash bookkeeping: three quick crashes mark a version bad, the last good one runs', () => {
  const s = L.emptyState();
  const ch = { stable: '2.0.0', minimum: '1.0.0' };
  s.lastGood = '1.9.0';
  assert.equal(L.chooseVersion(s, ch, ['1.9.0', '2.0.0']), '2.0.0');
  assert.equal(L.recordCrash(s, '2.0.0', 0), false);
  assert.equal(L.recordCrash(s, '2.0.0', 60_000), false);
  assert.equal(L.recordCrash(s, '2.0.0', 120_000), true);
  assert.equal(L.chooseVersion(s, ch, ['1.9.0', '2.0.0']), '1.9.0');
  // Crashes far apart do not add up.
  const t = L.emptyState();
  for (let i = 0; i < 5; i++) assert.equal(L.recordCrash(t, '3.0.0', i * L.CRASH_WINDOW_MS), false);
  // The channel moving on clears the situation.
  assert.equal(L.chooseVersion(s, { stable: '2.0.1', minimum: '1.0.0' }, ['1.9.0', '2.0.0']), '2.0.1');
  // A fallback below the channel minimum could never serve (told to update on login): not a candidate.
  assert.equal(L.chooseVersion(s, { stable: '2.0.0', minimum: '2.0.0' }, ['1.9.0', '2.0.0']), null);
  assert.equal(L.chooseVersion(s, { stable: '2.0.0', minimum: '1.9.5' }, ['1.9.0', '1.9.7', '2.0.0']), '1.9.7', 'the newest installed one at or above the minimum');
  assert.equal(L.chooseVersion(s, { stable: '2.0.0', minimum: '1.9.0' }, ['1.9.0', '2.0.0']), '1.9.0', 'at the minimum is fine');
  assert.equal(L.chooseVersion(s, { stable: '2.0.0', minimum: 'garbage' }, ['1.9.0', '2.0.0']), '1.9.0', 'an unreadable minimum is ignored');
  assert.equal(L.chooseVersion(s, { stable: '2.0.0' }, ['1.9.0', '2.0.0']), '1.9.0', 'no minimum');
});

// ---- the loop, with a fake node ---------------------------------------------------------------

/**
 * A fake node.mjs: records its start and every IPC message in `rec` (one JSON per line).
 *   quick75  exits 75 at once (a node below the channel minimum, told to update on welcome)
 *   stop0    exits 0 on any IPC message;  stop75  exits 75 on any IPC message (it was draining
 *            for an update when the stop came);  nowOnly  exits only on { t: 'stop-now' }
 *   busy     exits 2 at once while <rec>.busy exists (a port in use), else as stop0
 * It kills itself after 20 s so a failing test cannot leave it behind.
 */
function fakeNode(rec, version, mode) {
  return `import { appendFileSync, existsSync } from 'node:fs';
const note = (o) => appendFileSync(${JSON.stringify(rec)}, JSON.stringify({ v: ${JSON.stringify(version)}, ...o }) + '\\n');
const mode = ${JSON.stringify(mode)};
const busy = mode === 'busy' && existsSync(${JSON.stringify(rec + '.busy')});
note({ ev: 'start', ipc: typeof process.send === 'function', argv: process.argv.slice(2), busy });
if (mode === 'quick75') process.exit(75);
if (busy) process.exit(2);
process.on('message', (m) => {
  note({ ev: 'msg', m });
  if (mode === 'stop0' || mode === 'busy') process.exit(0);
  if (mode === 'stop75') process.exit(75);
  if (mode === 'nowOnly' && m && m.t === 'stop-now') process.exit(0);
});
setTimeout(() => process.exit(9), 20000);
`;
}

/**
 * A data dir with signed fake releases ({ version: mode }) served by a fake control plane whose
 * channel answers `channels` in order, then repeats the last. `installed` are downloaded up front.
 */
async function launcherEnv(modes, channels, state, installed = []) {
  const dir = await mkdtemp(join(tmpdir(), 'tgn-launch-'));
  const rec = join(dir, 'rec.jsonl');
  const rk = await generateEd25519();
  const key = await importPrivateKey(rk.privateKey);
  const rels = [];
  for (const [v, mode] of Object.entries(modes)) rels.push(await makeRelease(v, key, { 'node.mjs': enc.encode(fakeNode(rec, v, mode)) }));
  const f = fetcherFor('https://cp', rels, channels[0]);
  let calls = 0;
  f.json = async () => channels[Math.min(calls++, channels.length - 1)];
  if (state) await writeFile(join(dir, 'launcher.json'), JSON.stringify(state));
  for (const v of installed) await L.ensureRelease('https://cp', dir, v, rk.publicKey, f);
  return { dir, rec, releaseKey: rk.publicKey, f, runs: [] };
}

async function records(rec) {
  try {
    return (await readFile(rec, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
const starts = async (env) => (await records(env.rec)).filter((r) => r.ev === 'start');
const messages = async (env) => (await records(env.rec)).filter((r) => r.ev === 'msg').map((r) => r.m);

async function waitFor(what, pred, ms = 10_000) {
  const t0 = Date.now();
  while (!(await pred())) {
    if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const exists = (p) => access(p).then(() => true, () => false);

/** Starts a Launcher on `env` with no real waits (they are recorded) and no process signal handlers unless asked. */
function launch(env, opts = {}) {
  const logs = [];
  const sleeps = [];
  const l = new L.Launcher({
    control: 'https://cp',
    dataDir: env.dir,
    releaseKey: env.releaseKey,
    fetcher: env.f,
    log: (m) => logs.push(m),
    handleSignals: opts.handleSignals ?? false,
    stopPollMs: 50,
    sleep: async (ms) => {
      sleeps.push(ms);
      await opts.onSleep?.(ms, sleeps, l);
    },
  });
  const done = l.run();
  const finished = async (ms = 15_000) => {
    let timer;
    const late = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error('launcher did not exit:\n' + logs.join('\n'))), ms);
    });
    try {
      return await Promise.race([done, late]);
    } finally {
      clearTimeout(timer);
    }
  };
  const run = { l, logs, sleeps, done, finished };
  env.runs.push(run);
  return run;
}

/** Stops every launcher started on `env` (a failed test must not leave one running) and removes the dir. */
async function cleanup(env) {
  for (const run of env.runs) {
    run.l.requestStop('cleanup', true);
    await run.done.catch(() => undefined);
  }
  await rm(env.dir, { recursive: true, force: true });
}

test('stop vs update: SIGTERM, then the node exits 75, ends the launcher with 0 and starts nothing', async () => {
  const env = await launcherEnv({ '1.0.0': 'stop75', '1.1.0': 'stop0' }, [{ stable: '1.0.0', minimum: '1.0.0' }, { stable: '1.1.0', minimum: '1.0.0' }]);
  let run;
  try {
    run = launch(env, { handleSignals: true });
    await waitFor('the node to start', async () => (await starts(env)).length === 1);
    assert.equal(process.listeners('SIGTERM').length, 1);
    process.emit('SIGTERM'); // what systemd / launchd do, through the real handler (no real signal)
    assert.equal(await run.finished(), 0);
    const s = await starts(env);
    assert.deepEqual(s.map((r) => r.v), ['1.0.0'], 'no second start, although the channel moved to 1.1.0');
    assert.equal(s[0].ipc, true, 'the node has an IPC channel');
    assert.deepEqual(s[0].argv.slice(0, 3), ['run', '--data', env.dir]);
    assert.deepEqual(await messages(env), [{ t: 'stop' }], 'the SIGTERM went over IPC');
    assert.ok(run.logs.some((m) => /exited with 75 after the stop request/.test(m)), run.logs.join('\n'));
    assert.deepEqual(run.sleeps, []);
    assert.equal(process.listeners('SIGTERM').length, 0, 'signal handlers removed on exit');
    assert.equal(process.listeners('SIGINT').length, 0);
  } finally {
    await cleanup(env);
  }
});

test('stop vs update: a second SIGINT asks for stop-now; a stop before any node runs exits at once', async () => {
  const env = await launcherEnv({ '1.0.0': 'nowOnly' }, [{ stable: '1.0.0', minimum: '1.0.0' }]);
  let run;
  try {
    run = launch(env, { handleSignals: true });
    await waitFor('the node to start', async () => (await starts(env)).length === 1);
    process.emit('SIGINT');
    await waitFor('the stop message', async () => (await messages(env)).length === 1);
    process.emit('SIGINT');
    assert.equal(await run.finished(), 0);
    assert.deepEqual(await messages(env), [{ t: 'stop' }, { t: 'stop-now' }]);
    // A fresh stop.request found at start: nothing is started.
    await writeFile(join(env.dir, 'stop.request'), '');
    const second = launch(env);
    assert.equal(await second.finished(), 0);
    assert.equal((await starts(env)).length, 1);
    assert.equal(await exists(join(env.dir, 'stop.request')), false);
  } finally {
    await cleanup(env);
  }
});

test('update loop: a node that exits 75 right away waits 5 s doubling to 5 min; a real update does not wait', async () => {
  // The stable 2.0.0 cannot be downloaded (not on the server), so the installed 1.0.0 runs, which
  // is below the minimum: the node is told to update on every welcome.
  const env = await launcherEnv({ '1.0.0': 'quick75' }, [{ stable: '2.0.0', minimum: '2.0.0' }], {
    lastGood: '1.0.0',
    bad: [],
    badAt: {},
    crashes: {},
  }, ['1.0.0']);
  env.f.map.delete('https://cp/nodes/releases/2.0.0/manifest.json');
  let run;
  try {
    run = launch(env, {
      onSleep: (ms, sleeps, l) => {
        if (sleeps.length === 8) l.requestStop('test');
      },
    });
    assert.equal(await run.finished(), 0);
    assert.deepEqual(run.sleeps, [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
    assert.equal((await starts(env)).length, 8, 'one start per wait');
    assert.ok(run.logs.some((m) => /below the channel minimum 2\.0\.0/.test(m)), run.logs.join('\n'));
    assert.ok(run.logs.filter((m) => /release check failed/.test(m)).length >= 8, 'the download is retried before each start');
  } finally {
    await cleanup(env);
  }

  // The channel moves on after a quick 75: the new version starts with no wait.
  const env2 = await launcherEnv({ '1.0.0': 'quick75', '1.1.0': 'stop0' }, [{ stable: '1.0.0', minimum: '1.0.0' }, { stable: '1.1.0', minimum: '1.1.0' }]);
  let run2;
  try {
    run2 = launch(env2);
    await waitFor('1.1.0 to start', async () => (await starts(env2)).some((r) => r.v === '1.1.0'));
    run2.l.requestStop('test');
    assert.equal(await run2.finished(), 0);
    assert.deepEqual((await starts(env2)).map((r) => r.v), ['1.0.0', '1.1.0']);
    assert.deepEqual(run2.sleeps, []);
  } finally {
    await cleanup(env2);
  }
});

test('bad marks: they expire after 24 h, a long run clears them, and an all-bad machine still retries', async () => {
  const T0 = 1_700_000_000_000;
  const s = L.emptyState();
  for (const dt of [0, 1_000, 2_000]) L.recordCrash(s, '2.0.0', T0 + dt);
  assert.deepEqual(s.bad, ['2.0.0']);
  assert.equal(s.badAt['2.0.0'], T0 + 2_000);
  assert.deepEqual(L.expireBad(s, T0 + 2_000 + L.BAD_TTL_MS - 1), []);
  assert.deepEqual(s.bad, ['2.0.0']);
  assert.deepEqual(L.expireBad(s, T0 + 2_000 + L.BAD_TTL_MS), ['2.0.0']);
  assert.deepEqual(s.bad, []);
  assert.equal(s.crashes['2.0.0'], undefined, 'its crash history goes too');
  assert.deepEqual(s.badAt, {});
  // A mark written by an older launcher (no time): its 24 h start now, it does not vanish at once.
  const legacy = { ...L.emptyState(), bad: ['1.0.0'] };
  assert.deepEqual(L.expireBad(legacy, T0), []);
  assert.equal(legacy.badAt['1.0.0'], T0);
  // Running past the crash window clears the mark; a shorter run does not.
  for (const dt of [0, 1_000, 2_000]) L.recordCrash(s, '3.0.0', T0 + dt);
  assert.equal(L.recordRun(s, '3.0.0', L.CRASH_WINDOW_MS - 1), false);
  assert.deepEqual(s.bad, ['3.0.0']);
  assert.equal(L.recordRun(s, '3.0.0', L.CRASH_WINDOW_MS), true);
  assert.deepEqual(s.bad, []);
  assert.equal(s.crashes['3.0.0'], undefined);
  assert.equal(s.lastGood, '3.0.0');
  // Offline, a bad lastGood is not run.
  const off = { ...L.emptyState(), lastGood: '1.0.0', bad: ['1.0.0'], badAt: { '1.0.0': T0 } };
  assert.equal(L.offlineVersion(off, ['1.0.0', '0.9.0']), '0.9.0');

  // In the loop: an expired mark is dropped and saved, and the version runs with no wait.
  const env = await launcherEnv({ '1.0.0': 'stop0' }, [{ stable: '1.0.0', minimum: '1.0.0' }], {
    lastGood: null,
    bad: ['1.0.0'],
    badAt: { '1.0.0': Date.now() - L.BAD_TTL_MS - 1_000 },
    crashes: { '1.0.0': [1, 2, 3] },
  });
  let run;
  try {
    run = launch(env);
    await waitFor('the node to start', async () => (await starts(env)).length === 1);
    run.l.requestStop('test');
    assert.equal(await run.finished(), 0);
    assert.deepEqual(run.sleeps, []);
    assert.ok(run.logs.some((m) => /bad mark of 1\.0\.0 expired/.test(m)), run.logs.join('\n'));
    const saved = JSON.parse(await readFile(join(env.dir, 'launcher.json'), 'utf8'));
    assert.deepEqual(saved.bad, []);
    assert.equal(saved.crashes['1.0.0'], undefined);
  } finally {
    await cleanup(env);
  }

  // Every version bad (a transient crash hit them all): the stable is still retried, after a wait.
  const env2 = await launcherEnv({ '1.0.0': 'stop0' }, [{ stable: '1.0.0', minimum: '1.0.0' }], {
    lastGood: '1.0.0',
    bad: ['1.0.0'],
    badAt: { '1.0.0': Date.now() },
    crashes: {},
  });
  let run2;
  try {
    run2 = launch(env2);
    await waitFor('the node to start', async () => (await starts(env2)).length === 1);
    run2.l.requestStop('test');
    assert.equal(await run2.finished(), 0);
    assert.deepEqual(run2.sleeps, [5_000]);
    assert.ok(run2.logs.some((m) => /1\.0\.0 is marked bad and there is no other version to run/.test(m)), run2.logs.join('\n'));
  } finally {
    await cleanup(env2);
  }
});

test('rollback below the minimum: a stable marked bad by a passing fault is retried within the backoff, not after 24 h', async () => {
  // scripts/build-node.mjs publishes minimum = stable: after the update to 2.0.0, the last good
  // 1.9.0 is below the minimum and would only be told to update. 2.0.0 fails to start 3 times
  // (a port in use: exit 2), which marks it bad; then the port is free again.
  const env = await launcherEnv({ '1.9.0': 'quick75', '2.0.0': 'busy' }, [{ stable: '2.0.0', minimum: '2.0.0' }], {
    lastGood: '1.9.0',
    bad: [],
    badAt: {},
    crashes: {},
  }, ['1.9.0']);
  await writeFile(env.rec + '.busy', '');
  let run;
  try {
    run = launch(env, {
      onSleep: async () => {
        if ((await starts(env)).filter((r) => r.busy).length >= 3) await rm(env.rec + '.busy', { force: true }); // the port is free again
      },
    });
    await waitFor('2.0.0 to start and serve', async () => (await starts(env)).some((r) => r.v === '2.0.0' && !r.busy));
    run.l.requestStop('test');
    assert.equal(await run.finished(), 0);
    const s = await starts(env);
    assert.deepEqual(s.map((r) => `${r.v}${r.busy ? ' busy' : ''}`), ['2.0.0 busy', '2.0.0 busy', '2.0.0 busy', '2.0.0'], '1.9.0 never runs');
    // Crash backoff 5, 10, 20 s (the third crash marks it bad), then the last-resort retry after 5 s.
    assert.deepEqual(run.sleeps, [5_000, 10_000, 20_000, 5_000]);
    assert.ok(run.logs.some((m) => /2\.0\.0 crashed 3 times: marked bad/.test(m)), run.logs.join('\n'));
    assert.ok(run.logs.some((m) => /no other version to run \(none here is good and at least the channel minimum 2\.0\.0\)/.test(m)), run.logs.join('\n'));
    assert.deepEqual(await messages(env), [{ t: 'stop' }]);
  } finally {
    await cleanup(env);
  }
});

test('stop.request: the file sends { t: "stop" } over IPC and is deleted; again (or "now") sends stop-now', async () => {
  const env = await launcherEnv({ '1.0.0': 'stop0' }, [{ stable: '1.0.0', minimum: '1.0.0' }]);
  let run;
  try {
    run = launch(env);
    await waitFor('the node to start', async () => (await starts(env)).length === 1);
    await writeFile(join(env.dir, 'stop.request'), 'stop');
    assert.equal(await run.finished(), 0);
    assert.deepEqual(await messages(env), [{ t: 'stop' }]);
    assert.equal(await exists(join(env.dir, 'stop.request')), false, 'the request is consumed');
    assert.equal((await starts(env)).length, 1);
  } finally {
    await cleanup(env);
  }

  const env2 = await launcherEnv({ '1.0.0': 'nowOnly' }, [{ stable: '1.0.0', minimum: '1.0.0' }]);
  let run2;
  try {
    // An old leftover request is removed without being obeyed.
    const leftover = join(env2.dir, 'stop.request');
    await writeFile(leftover, '');
    const old = new Date(Date.now() - L.STALE_STOP_MS - 60_000);
    await utimes(leftover, old, old);
    run2 = launch(env2);
    await waitFor('the node to start', async () => (await starts(env2)).length === 1);
    assert.equal(await exists(leftover), false);
    await writeFile(leftover, '');
    await waitFor('the stop message', async () => (await messages(env2)).length === 1);
    await writeFile(leftover, '');
    assert.equal(await run2.finished(), 0);
    assert.deepEqual(await messages(env2), [{ t: 'stop' }, { t: 'stop-now' }]);
  } finally {
    await cleanup(env2);
  }

  const env3 = await launcherEnv({ '1.0.0': 'nowOnly' }, [{ stable: '1.0.0', minimum: '1.0.0' }]);
  let run3;
  try {
    run3 = launch(env3);
    await waitFor('the node to start', async () => (await starts(env3)).length === 1);
    await writeFile(join(env3.dir, 'stop.request'), 'now\r\n');
    assert.equal(await run3.finished(), 0);
    assert.deepEqual(await messages(env3), [{ t: 'stop-now' }]);
  } finally {
    await cleanup(env3);
  }
});
