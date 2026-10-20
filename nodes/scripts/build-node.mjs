// Build a node release:
//   dist/releases/<version>/node.mjs        the node program, one ESM bundle (esbuild), no dependencies
//   dist/releases/<version>/rocketsim.wasm  the exact wasm the web client runs
//   dist/releases/<version>/manifest.json   version, protocol, wasm hash, commit, files with sha256 + size
//   dist/releases/<version>/inputs.json     the repo files node.mjs was built from (its sha256 is in the
//                                           manifest; not in its files, so launchers never download it)
//   dist/releases/launcher.mjs              the launcher install.sh installs once
//   dist/releases/install.sh, install-windows.ps1, install-desktop.sh   with the release public key filled in
//
//   node scripts/build-node.mjs                            production: unsigned, for scripts/sign-release.mjs
//   node scripts/build-node.mjs --sign .keys/release.json  development (npm run build): signed with a local key
//
// Production builds a commit (a dirty tree is refused and the manifest records the commit) and fills
// the installers from nodes/release-key.pub, the project's release key. It never sees the private
// half: CI signs in a job of its own, with a script that only uses node:crypto (scripts/sign-release.mjs).
// Development signs with a key from scripts/keys.mjs (manifest.sig, launcher.mjs.sig,
// <version>/release-key.pub) and fills the installers with that key: such a release only works with
// launchers installed from those installers, and is never uploaded.
// Neither mode writes channel.json: the channel moves only through the deploy gate
// (scripts/node-release-gate.mjs at the repo root) or scripts/channel.mjs, so a stray upload cannot
// move it.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { createHash, createPublicKey } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findRepoRoot } from './repo-root.mjs';
import { INSTALLERS } from './release-check.mjs';
import { fillInstaller, PLACEHOLDER, privateKeyFromText, rawOf, readReleaseKey, signB64 } from './release-key.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// compareVersions (shared/controlProtocol.ts) mis-orders prerelease suffixes.
const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;

const sha = (b) => createHash('sha256').update(b).digest('hex');

function gitIn(repo) {
  return (args) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.error?.message || '').trim()}`);
    return r.stdout;
  };
}

/**
 * The repo files an esbuild metafile lists, as git tracks them: a package under node_modules counts
 * as the lockfile that pins it, so `git diff` sees every change that reaches the bundle.
 */
export function inputFiles(metafile) {
  const files = new Set();
  for (const p of Object.keys(metafile.inputs)) {
    if (p.startsWith('../') || p.startsWith('/') || /^[A-Za-z]:/.test(p)) throw new Error(`the bundle reads ${p}, outside the repo`);
    const i = p.indexOf('node_modules/');
    files.add(i < 0 ? p : `${p.slice(0, i)}package-lock.json`);
  }
  return [...files].sort();
}

/** The public half of the development key in a scripts/keys.mjs file, or null. */
async function devPublicKey(file) {
  try {
    const j = JSON.parse(await readFile(file, 'utf8'));
    return typeof j.publicKey === 'string' ? j.publicKey : rawOf(privateKeyFromText(j.privateKey));
  } catch {
    return null;
  }
}

async function committedKey(file) {
  try {
    return readReleaseKey(file);
  } catch {
    return null;
  }
}

/**
 * Build the release. Options (tests): root (nodes/), out, sign (a keys.mjs file: development mode),
 * releaseKeyFile, devKeyFile, env, git(args) -> stdout, log.
 */
export async function buildRelease(o = {}) {
  const root = o.root ?? ROOT;
  const repo = findRepoRoot(root);
  const out = o.out ?? join(root, 'dist', 'releases');
  const env = o.env ?? process.env;
  const log = o.log ?? console.log;
  const git = o.git ?? gitIn(repo);
  const releaseKeyFile = o.releaseKeyFile ?? join(root, 'release-key.pub');
  const devKeyFile = o.devKeyFile ?? join(root, '.keys', 'release.json');

  // The release key never shares a process with esbuild or the code it bundles.
  if (env.TGN_RELEASE_PRIVATE_KEY) throw new Error('TGN_RELEASE_PRIVATE_KEY is set: the build never sees the release key (sign with scripts/sign-release.mjs, in a step of its own)');

  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const versionTs = await readFile(join(root, 'node', 'version.ts'), 'utf8');
  const version = /NODE_VERSION = '([^']+)'/.exec(versionTs)?.[1];
  if (version !== pkg.version) throw new Error(`node/version.ts (${version}) and package.json (${pkg.version}) differ`);
  if (!PLAIN_VERSION.test(version)) throw new Error(`version ${version}: releases are plain X.Y.Z`);
  const protocolTs = await readFile(join(repo, 'src', 'net', 'protocol.ts'), 'utf8');
  const protocol = Number(/PROTOCOL_VERSION = (\d+)/.exec(protocolTs)?.[1]);

  // scripts/keys.mjs keeps any key file it finds, so the development key and the committed one being
  // the same key means one of two mistakes: the production private key sits on this disk, or
  // release-key.pub was committed from a development key.
  const sameKey = 'is the key in nodes/release-key.pub: either the production private key is on this disk (it belongs in the password manager and the releases environment only) or release-key.pub was committed from a development key. Move .keys/ away and run npm run keys for a new development key';
  let signer = null;
  let publicKey;
  let commit = null;
  if (o.sign) {
    signer = privateKeyFromText(await readFile(o.sign, 'utf8'));
    const key = await committedKey(releaseKeyFile);
    if (key && key.raw === rawOf(signer)) throw new Error(`${o.sign} ${sameKey}`);
    publicKey = { raw: rawOf(signer), pem: createPublicKey(signer).export({ format: 'pem', type: 'spki' }).toString().trim() };
  } else {
    publicKey = readReleaseKey(releaseKeyFile);
    if ((await devPublicKey(devKeyFile)) === publicKey.raw) throw new Error(`${devKeyFile} ${sameKey}`);
    const dirty = git(['status', '--porcelain']).trim();
    if (dirty) throw new Error(`uncommitted changes: a release is built from a commit (development builds: npm run build)\n${dirty.split('\n').slice(0, 10).join('\n')}`);
    commit = (env.GITHUB_SHA || git(['rev-parse', 'HEAD'])).trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`bad commit ${commit}`);
  }

  const require = createRequire(import.meta.url);
  const esbuild = require(join(repo, 'server', 'node_modules', 'esbuild'));
  const rel = join(out, version);
  // Start clean: a signature or channel.json left by an earlier build must not ship with this one.
  await rm(rel, { recursive: true, force: true });
  for (const stale of ['launcher.mjs.sig', 'channel.json']) await rm(join(out, stale), { force: true });
  await mkdir(rel, { recursive: true });

  // CommonJS dependencies (werift's) call require('tty') & co.: give the ESM bundle a real `require`.
  const banner = { js: "import { createRequire as __tgnCreateRequire } from 'node:module'; const require = __tgnCreateRequire(import.meta.url);" };
  const common = { bundle: true, platform: 'node', format: 'esm', target: 'node24', legalComments: 'inline', logLevel: 'warning', banner };
  // absWorkingDir: the metafile lists inputs relative to the repo root, as git names them.
  const node = await esbuild.build({ ...common, entryPoints: [join(root, 'node', 'main.ts')], outfile: join(rel, 'node.mjs'), metafile: true, absWorkingDir: repo });
  await esbuild.build({ ...common, entryPoints: [join(root, 'node', 'launcherMain.ts')], outfile: join(out, 'launcher.mjs') });
  await copyFile(join(repo, 'src', 'sim', 'wasm', 'rocketsim.wasm'), join(rel, 'rocketsim.wasm'));

  // The wasm is copied, not bundled: list it too, so a deploy sees it like any other input.
  const inputs = [...new Set([...inputFiles(node.metafile), 'src/sim/wasm/rocketsim.wasm'])].sort();
  const inputsBytes = Buffer.from(JSON.stringify({ version, files: inputs }, null, 2));
  await writeFile(join(rel, 'inputs.json'), inputsBytes);

  const files = [];
  for (const path of ['node.mjs', 'rocketsim.wasm']) {
    const b = await readFile(join(rel, path));
    files.push({ path, sha256: sha(b), size: b.length });
  }
  // Launchers ignore the fields they do not know (commit, inputsSha256).
  const manifest = {
    name: 'turbogol-node',
    version,
    protocol,
    wasmSha256: files.find((f) => f.path === 'rocketsim.wasm').sha256,
    nodeMajor: 24,
    entry: 'node.mjs',
    createdAt: new Date().toISOString(),
    ...(commit ? { commit } : {}),
    inputsSha256: sha(inputsBytes),
    files,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
  await writeFile(join(rel, 'manifest.json'), manifestBytes);

  if (signer) {
    await writeFile(join(rel, 'manifest.sig'), signB64(manifestBytes, signer));
    await writeFile(join(out, 'launcher.mjs.sig'), signB64(await readFile(join(out, 'launcher.mjs')), signer));
    await writeFile(join(rel, 'release-key.pub'), publicKey.raw);
  }

  // Installers: VPS (install.sh), Windows home PCs, macOS / Linux desktops. The release key is baked
  // in; an installer still carrying the placeholders refuses to run.
  for (const name of INSTALLERS) {
    let tpl;
    try {
      tpl = await readFile(join(root, 'install', name), 'utf8');
    } catch {
      if (!signer) throw new Error(`install/${name} is missing`);
      log(`  (no install/${name} yet)`);
      continue;
    }
    const filled = fillInstaller(tpl, publicKey);
    if (filled.includes(PLACEHOLDER)) throw new Error(`install/${name} still has a ${PLACEHOLDER}* placeholder`);
    await writeFile(join(out, name), filled);
  }

  log(`release ${version} (protocol ${protocol}, wasm ${manifest.wasmSha256.slice(0, 12)}${commit ? `, commit ${commit.slice(0, 12)}` : ''}) -> ${rel}`);
  for (const f of files) log(`  ${f.path}  ${(f.size / 1024).toFixed(0)} KB  ${f.sha256.slice(0, 16)}`);
  log(`  inputs.json  ${inputs.length} files`);
  if (signer) {
    log(`signed with ${o.sign} (public key ${publicKey.raw})`);
    log('DEV KEY: never upload this release. Only launchers installed from these installers accept it, never the ones from turbo-gol.com.');
  } else {
    log(`UNSIGNED: installers carry the release key ${publicKey.raw}; sign with scripts/sign-release.mjs`);
  }
  return { version, dir: rel, manifest, inputs, publicKey: publicKey.raw };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--sign');
  try {
    if (i > 0 && !process.argv[i + 1]) throw new Error('--sign needs a key file (.keys/release.json)');
    await buildRelease({ sign: i > 0 ? process.argv[i + 1] : null });
  } catch (e) {
    console.error(`build-node: ${e.message}`);
    process.exit(1);
  }
}
