// scripts/sign-release.mjs, the only process that ever holds the release private key: it signs a
// production build only with the key whose public half is release-key.pub, only when every file
// matches the manifest and the installers carry that key, and it never prints the key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSign, signerRoot, tempDir, throwawayKey } from './release-fixtures.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const COMMIT = 'f00d'.padEnd(40, '1');
const VERSION = '3.4.5';

const pemOf = (raw) => createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' }).export({ format: 'pem', type: 'spki' }).toString().trim();

/** A production build's output as build-node.mjs lays it out, small enough to write by hand. */
function fakeDist(t, raw, { commit = COMMIT } = {}) {
  const out = tempDir(t, 'tgn-dist-');
  const rel = join(out, VERSION);
  mkdirSync(rel);
  const files = [];
  for (const [path, text] of [['node.mjs', 'console.log("node")'], ['rocketsim.wasm', 'wasm']]) {
    writeFileSync(join(rel, path), text);
    files.push({ path, sha256: sha(Buffer.from(text)), size: Buffer.byteLength(text) });
  }
  const inputs = Buffer.from(JSON.stringify({ version: VERSION, files: ['nodes/node/main.ts'] }));
  writeFileSync(join(rel, 'inputs.json'), inputs);
  const manifest = { name: 'turbogol-node', version: VERSION, protocol: 1, wasmSha256: files[1].sha256, nodeMajor: 24, entry: 'node.mjs', createdAt: '2026-10-19T00:00:00Z', ...(commit ? { commit } : {}), inputsSha256: sha(inputs), files };
  writeFileSync(join(rel, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(out, 'launcher.mjs'), 'console.log("launcher")');
  const installer = `RELEASE_KEY_B64URL="${raw}"\nRELEASE_KEY_PEM="${pemOf(raw)}"\n`;
  writeFileSync(join(out, 'install.sh'), installer);
  writeFileSync(join(out, 'install-desktop.sh'), installer);
  writeFileSync(join(out, 'install-windows.ps1'), installer.replace(/\n/g, '\r\n'));
  return { out, rel };
}

test('signs manifest.json and launcher.mjs with the key of release-key.pub (from --key or the environment)', (t) => {
  const key = throwawayKey();
  const root = signerRoot(t, key.raw, VERSION);
  const { out, rel } = fakeDist(t, key.raw);
  const keyFile = join(tempDir(t, 'tgn-key-'), 'release.json');
  writeFileSync(keyFile, JSON.stringify({ publicKey: key.raw, privateKey: key.pkcs8 }));
  for (const how of [['--key', keyFile], []]) {
    const r = runSign(root, ['--dist', out, ...how], how.length ? {} : { TGN_RELEASE_PRIVATE_KEY: `${key.pkcs8}\n` });
    assert.equal(r.status, 0, r.out);
    assert.ok(!r.out.includes(key.pkcs8));
    const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.raw }, format: 'jwk' });
    const ok = (file, sigFile) => verify(null, readFileSync(file), pub, Buffer.from(readFileSync(sigFile, 'utf8'), 'base64url'));
    assert.ok(ok(join(rel, 'manifest.json'), join(rel, 'manifest.sig')));
    assert.ok(ok(join(out, 'launcher.mjs'), join(out, 'launcher.mjs.sig')));
    assert.equal(readFileSync(join(rel, 'release-key.pub'), 'utf8'), key.raw);
  }
});

test('refuses a key that is not release-key.pub, the committed one included, and never prints it', (t) => {
  const stranger = throwawayKey();
  const key = throwawayKey();
  const { out } = fakeDist(t, key.raw);
  let r = runSign(signerRoot(t, key.raw, VERSION), ['--dist', out], { TGN_RELEASE_PRIVATE_KEY: stranger.pkcs8 });
  assert.equal(r.status, 1);
  assert.match(r.out, /does not match nodes\/release-key\.pub/);
  assert.ok(!r.out.includes(stranger.pkcs8));
  // The real script and the real nodes/release-key.pub: a throwaway key never signs a project release.
  const real = fileURLToPath(new URL('..', import.meta.url));
  r = runSign(real, ['--dist', out], { TGN_RELEASE_PRIVATE_KEY: stranger.pkcs8 });
  assert.equal(r.status, 1);
  assert.match(r.out, /does not match nodes\/release-key\.pub/);
  r = runSign(real, ['--dist', out], { TGN_RELEASE_PRIVATE_KEY: 'not a key' });
  assert.equal(r.status, 1);
  assert.match(r.out, /not an Ed25519 PKCS#8 key/);
  assert.match(runSign(real, ['--dist', out]).out, /no key/);
});

test('refuses installers without the key, files that do not match the manifest, development builds and another commit', (t) => {
  const key = throwawayKey();
  const root = signerRoot(t, key.raw, VERSION);
  const env = { TGN_RELEASE_PRIVATE_KEY: key.pkcs8 };
  const refused = (out, pattern, extra = {}) => {
    const r = runSign(root, ['--dist', out], { ...env, ...extra });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, pattern);
  };

  let d = fakeDist(t, key.raw);
  writeFileSync(join(d.out, 'install.sh'), 'RELEASE_KEY_B64URL="__RELEASE_PUBLIC_KEY_B64URL__"\n');
  refused(d.out, /install\.sh still has a __RELEASE_PUBLIC_KEY_\* placeholder/);

  d = fakeDist(t, throwawayKey().raw);
  refused(d.out, /install\.sh does not carry nodes\/release-key\.pub/);

  d = fakeDist(t, key.raw);
  writeFileSync(join(d.rel, 'node.mjs'), 'evil()');
  refused(d.out, /node\.mjs does not match manifest\.json/);

  d = fakeDist(t, key.raw);
  writeFileSync(join(d.rel, 'inputs.json'), '{}');
  refused(d.out, /inputs\.json does not match manifest\.json/);

  d = fakeDist(t, key.raw, { commit: null });
  refused(d.out, /not a production build/);

  d = fakeDist(t, key.raw);
  refused(d.out, /not from this run's commit/, { GITHUB_SHA: 'e'.repeat(40) });
});
