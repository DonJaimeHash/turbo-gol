// Sign a production node release (scripts/build-node.mjs without --sign) with the project's release
// key, in a process of its own: only node:crypto, node:fs and node:path (here, in ./release-key.mjs
// and in ./release-check.mjs), so the private key never shares a process with esbuild, werift or
// wrangler. CI runs it in the sign job of .github/workflows/node-release.yml, the only job that gets
// the key, and one that installs nothing.
//
//   node scripts/sign-release.mjs [--dist dist/releases] [--key <file>]
//
// The private key comes from $TGN_RELEASE_PRIVATE_KEY (PKCS#8 base64url: the privateKey field of a
// scripts/keys.mjs file) or from --key <file> (such a file, or the bare key), never from the command
// line itself. It refuses to sign unless the key's public half is nodes/release-key.pub, the key
// installers and launchers pin, and the build passes ./release-check.mjs: the manifest of
// nodes/package.json's version, from the commit in $GITHUB_SHA; every file it lists, and inputs.json,
// against the manifest; the wasm and the protocol against this checkout, and the installers byte
// for byte. node.mjs, launcher.mjs and inputs.json are not rebuilt: it signs what the build job (no
// secrets, a fresh runner) built.
// Writes <version>/manifest.sig and launcher.mjs.sig (base64url Ed25519 over the exact bytes, as
// node/launcher.ts and install.sh check them), verifies both back with release-key.pub, and writes
// <version>/release-key.pub.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkBuild } from './release-check.mjs';
import { privateKeyFromText, rawOf, readReleaseKey, signB64, verifyB64 } from './release-key.mjs';

const root = join(import.meta.dirname, '..');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  if (!process.argv[i + 1]) throw new Error(`--${name} needs a value`);
  return process.argv[i + 1];
}

function main() {
  const dist = resolve(arg('dist') ?? join(root, 'dist', 'releases'));
  const keyFile = arg('key');
  const keyText = keyFile ? readFileSync(keyFile, 'utf8') : process.env.TGN_RELEASE_PRIVATE_KEY;
  if (!keyText || !keyText.trim()) throw new Error('no key: set TGN_RELEASE_PRIVATE_KEY or pass --key <file>');

  const committed = readReleaseKey(join(root, 'release-key.pub'));
  const privateKey = privateKeyFromText(keyText);
  if (rawOf(privateKey) !== committed.raw) throw new Error(`this private key does not match nodes/release-key.pub (${committed.raw}): not signing`);

  const { version, rel, manifestBytes, manifest: m } = checkBuild({ nodes: root, dist, releaseKey: committed, commit: process.env.GITHUB_SHA });
  let launcher;
  try {
    launcher = readFileSync(join(dist, 'launcher.mjs'));
  } catch {
    throw new Error(`${join(dist, 'launcher.mjs')} is missing`);
  }
  const manifestSig = signB64(manifestBytes, privateKey);
  const launcherSig = signB64(launcher, privateKey);
  if (!verifyB64(manifestBytes, manifestSig, committed.key) || !verifyB64(launcher, launcherSig, committed.key)) throw new Error('a signature does not verify with nodes/release-key.pub');
  writeFileSync(join(rel, 'manifest.sig'), manifestSig);
  writeFileSync(join(dist, 'launcher.mjs.sig'), launcherSig);
  writeFileSync(join(rel, 'release-key.pub'), committed.raw);
  console.log(`signed release ${version} (commit ${m.commit.slice(0, 12)}) with release key ${committed.raw}: ${version}/manifest.sig, launcher.mjs.sig, ${version}/release-key.pub`);
}

try {
  main();
} catch (e) {
  console.error(`sign-release: ${e.message}`);
  process.exit(1);
}
