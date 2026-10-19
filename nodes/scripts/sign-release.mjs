// Sign a production node release (scripts/build-node.mjs without --sign) with the project's release
// key, in a process of its own: only node:crypto, node:fs and node:path (here and in
// ./release-key.mjs), so the private key never shares a process with esbuild, werift or wrangler.
// CI runs it in the publish job of .github/workflows/node-release.yml, the only step that gets the key.
//
//   node scripts/sign-release.mjs [--dist dist/releases] [--key <file>]
//
// The private key comes from $TGN_RELEASE_PRIVATE_KEY (PKCS#8 base64url: the privateKey field of a
// scripts/keys.mjs file) or from --key <file> (such a file, or the bare key), never from the command
// line itself. It refuses to sign unless:
//   - the key's public half is nodes/release-key.pub, the key installers and launchers pin;
//   - <dist>/<version>/manifest.json is a production build of nodes/package.json's version: it names
//     its commit (the one in $GITHUB_SHA, in CI), and every file it lists, inputs.json included,
//     matches its size and sha256;
//   - the three installers carry release-key.pub (raw and PEM) and no placeholder.
// Writes <version>/manifest.sig and launcher.mjs.sig (base64url Ed25519 over the exact bytes, as
// node/launcher.ts and install.sh check them), verifies both back with release-key.pub, and writes
// <version>/release-key.pub.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { privateKeyFromText, rawOf, readReleaseKey, signB64, verifyB64 } from './release-key.mjs';

const root = join(import.meta.dirname, '..');
const INSTALLERS = ['install.sh', 'install-windows.ps1', 'install-desktop.sh'];
// Not the bare `__RELEASE_` prefix: the installers' own refusal checks contain it.
const PLACEHOLDER = '__RELEASE_PUBLIC_KEY_';

const sha = (b) => createHash('sha256').update(b).digest('hex');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  if (!process.argv[i + 1]) throw new Error(`--${name} needs a value`);
  return process.argv[i + 1];
}

function read(file) {
  try {
    return readFileSync(file);
  } catch {
    throw new Error(`${file} is missing`);
  }
}

function main() {
  const dist = resolve(arg('dist') ?? join(root, 'dist', 'releases'));
  const keyFile = arg('key');
  const keyText = keyFile ? readFileSync(keyFile, 'utf8') : process.env.TGN_RELEASE_PRIVATE_KEY;
  if (!keyText || !keyText.trim()) throw new Error('no key: set TGN_RELEASE_PRIVATE_KEY or pass --key <file>');

  const committed = readReleaseKey(join(root, 'release-key.pub'));
  const privateKey = privateKeyFromText(keyText);
  if (rawOf(privateKey) !== committed.raw) throw new Error(`this private key does not match nodes/release-key.pub (${committed.raw}): not signing`);

  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const rel = join(dist, version);
  const manifestBytes = read(join(rel, 'manifest.json'));
  const m = JSON.parse(manifestBytes.toString('utf8'));
  if (m.name !== 'turbogol-node' || m.version !== version) throw new Error(`${rel}/manifest.json is not release ${version}`);
  if (!/^[0-9a-f]{40}$/.test(m.commit ?? '')) throw new Error('manifest.json names no commit: not a production build (node scripts/build-node.mjs, without --sign)');
  if (process.env.GITHUB_SHA && m.commit !== process.env.GITHUB_SHA) throw new Error(`manifest.json was built from ${m.commit}, not from this run's commit ${process.env.GITHUB_SHA}`);
  if (!Array.isArray(m.files) || m.files.length === 0) throw new Error('manifest.json lists no files');
  for (const f of m.files) {
    const b = read(join(rel, f.path));
    if (b.length !== f.size || sha(b) !== f.sha256) throw new Error(`${f.path} does not match manifest.json`);
  }
  if (sha(read(join(rel, 'inputs.json'))) !== m.inputsSha256) throw new Error('inputs.json does not match manifest.json');

  for (const name of INSTALLERS) {
    const text = read(join(dist, name)).toString('utf8').replace(/\r\n/g, '\n');
    if (text.includes(PLACEHOLDER)) throw new Error(`${name} still has a ${PLACEHOLDER}* placeholder`);
    if (!text.includes(committed.raw) || !text.includes(committed.pem)) throw new Error(`${name} does not carry nodes/release-key.pub`);
  }

  const launcher = read(join(dist, 'launcher.mjs'));
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
