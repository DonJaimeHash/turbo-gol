// The release build (scripts/build-node.mjs) with throwaway keys and a fake git. A production build
// is unsigned, names its commit and input list, and fills the installers from release-key.pub; once
// scripts/sign-release.mjs signs it, launchers accept exactly what was built. A development build
// signs with a local key and says it must never be uploaded.
import '../dev/ts-resolve.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSign, signerRoot, tempDir, throwawayKey } from './release-fixtures.mjs';

const { buildRelease, INSTALLERS, PLACEHOLDER } = await import('../scripts/build-node.mjs');
const L = await import('../node/launcher.ts');

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const COMMIT = 'c0ffee'.padEnd(40, '0');

/** git for a checkout at COMMIT; `status` is what `git status --porcelain` prints. */
const fakeGit =
  (status = '') =>
  (args) => {
    if (args[0] === 'status') return status;
    if (args[0] === 'rev-parse') return `${COMMIT}\n`;
    throw new Error(`unexpected git ${args.join(' ')}`);
  };

/** Options for a production build into a temporary folder, with a throwaway release key. */
function production(t) {
  const dir = tempDir(t, 'tgn-build-');
  const key = throwawayKey();
  const releaseKeyFile = join(dir, 'release-key.pub');
  writeFileSync(releaseKeyFile, `${key.raw}\n`);
  const lines = [];
  const opts = { out: join(dir, 'out'), releaseKeyFile, devKeyFile: join(dir, 'no-dev-key.json'), env: {}, git: fakeGit(), log: (m) => lines.push(m) };
  return { dir, key, opts, lines };
}

const pubOf = (raw) => createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' });

test('production build: unsigned, with its commit and input list, installers filled from release-key.pub, no channel.json; once signed, launchers accept it', async (t) => {
  const { key, opts, lines } = production(t);
  await buildRelease(opts);
  const rel = join(opts.out, VERSION);
  const mb = readFileSync(join(rel, 'manifest.json'));
  const m = JSON.parse(mb);
  assert.equal(m.commit, COMMIT);
  for (const f of [join(rel, 'manifest.sig'), join(opts.out, 'launcher.mjs.sig'), join(rel, 'release-key.pub'), join(opts.out, 'channel.json')]) assert.equal(existsSync(f), false, f);
  assert.match(lines.join('\n'), /UNSIGNED/);

  // inputs.json: repo paths as git tracks them (a dependency is its lockfile), hashed in the
  // signed manifest but not one of its files, so launchers never download it.
  const inputsBytes = readFileSync(join(rel, 'inputs.json'));
  assert.equal(createHash('sha256').update(inputsBytes).digest('hex'), m.inputsSha256);
  assert.deepEqual(m.files.map((f) => f.path), ['node.mjs', 'rocketsim.wasm']);
  const inputs = JSON.parse(inputsBytes).files;
  for (const p of ['nodes/node/main.ts', 'nodes/shared/verify.ts', 'nodes/package-lock.json', 'server/src/roomHost.ts', 'src/game/Match.ts', 'src/net/protocol.ts', 'src/sim/wasm/rocketsim.wasm']) assert.ok(inputs.includes(p), p);
  assert.ok(inputs.every((p) => !p.includes('node_modules') && !p.includes('\\')), 'repo paths only');

  for (const name of INSTALLERS) {
    const text = readFileSync(join(opts.out, name), 'utf8');
    assert.ok(!text.includes(PLACEHOLDER), name);
    assert.ok(text.includes(key.raw), name);
    assert.ok(text.includes('-----BEGIN PUBLIC KEY-----'), name);
  }

  // The signing step as CI runs it: the key in the environment, the run's commit in GITHUB_SHA.
  const r = runSign(signerRoot(t, key.raw, VERSION), ['--dist', opts.out], { TGN_RELEASE_PRIVATE_KEY: key.pkcs8, GITHUB_SHA: COMMIT });
  assert.equal(r.status, 0, r.out);
  assert.ok(!r.out.includes(key.pkcs8), 'the private key is never printed');
  const sig = readFileSync(join(rel, 'manifest.sig'), 'utf8');
  const verified = await L.verifyManifest(new Uint8Array(mb), sig, key.raw);
  for (const f of verified.files) await L.checkFile(f, new Uint8Array(readFileSync(join(rel, f.path))));
  assert.ok(verify(null, readFileSync(join(opts.out, 'launcher.mjs')), pubOf(key.raw), Buffer.from(readFileSync(join(opts.out, 'launcher.mjs.sig'), 'utf8'), 'base64url')), 'launcher.mjs.sig');
  assert.equal(readFileSync(join(rel, 'release-key.pub'), 'utf8'), key.raw);
  // A launcher that pinned another key refuses it.
  await assert.rejects(L.verifyManifest(new Uint8Array(mb), sig, throwawayKey().raw), /signature/);
});

test('production build refuses a dirty tree, the release key in its environment, a broken release-key.pub, and a development key that is the release key', async (t) => {
  const { dir, key, opts } = production(t);
  await assert.rejects(buildRelease({ ...opts, git: fakeGit(' M src/game/Match.ts\n?? nodes/node/new.ts') }), /uncommitted changes[\s\S]*nodes\/node\/new\.ts/);
  await assert.rejects(buildRelease({ ...opts, env: { TGN_RELEASE_PRIVATE_KEY: throwawayKey().pkcs8 } }), /never sees the release key/);
  for (const bad of ['__RELEASE_PUBLIC_KEY_B64URL__', key.raw.slice(1), '']) {
    writeFileSync(opts.releaseKeyFile, bad);
    await assert.rejects(buildRelease(opts), /release-key\.pub: not a release public key/);
  }
  writeFileSync(opts.releaseKeyFile, key.raw);
  // scripts/keys.mjs keeps a key file it finds: the dev key must never be the committed one.
  const devKeyFile = join(dir, 'release.json');
  writeFileSync(devKeyFile, JSON.stringify({ publicKey: key.raw, privateKey: key.pkcs8 }));
  await assert.rejects(buildRelease({ ...opts, devKeyFile }), /production private key is on this disk/);
});

test('development build (--sign): signed with the local key, says DEV KEY, and never signs with the release key', async (t) => {
  const { dir, key, opts, lines } = production(t);
  const dev = throwawayKey();
  const devFile = join(dir, 'release.json');
  writeFileSync(devFile, JSON.stringify({ publicKey: dev.raw, privateKey: dev.pkcs8 }));
  const noGit = () => assert.fail('a development build runs no git');
  await buildRelease({ ...opts, sign: devFile, git: noGit });
  assert.match(lines.join('\n'), /DEV KEY: never upload/);
  const rel = join(opts.out, VERSION);
  const mb = readFileSync(join(rel, 'manifest.json'));
  assert.equal(JSON.parse(mb).commit, undefined, 'only production builds name a commit');
  await L.verifyManifest(new Uint8Array(mb), readFileSync(join(rel, 'manifest.sig'), 'utf8'), dev.raw);
  assert.equal(readFileSync(join(rel, 'release-key.pub'), 'utf8'), dev.raw);
  for (const name of INSTALLERS) assert.ok(readFileSync(join(opts.out, name), 'utf8').includes(dev.raw), name);
  assert.equal(existsSync(join(opts.out, 'channel.json')), false);

  // The production key sitting in .keys/release.json: refused before anything is signed.
  const prodFile = join(dir, 'prod.json');
  writeFileSync(prodFile, JSON.stringify({ publicKey: key.raw, privateKey: key.pkcs8 }));
  await assert.rejects(buildRelease({ ...opts, sign: prodFile, git: noGit }), /production private key is on this disk/);
});
