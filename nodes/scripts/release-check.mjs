// What a production node release (scripts/build-node.mjs without --sign) must be before it is signed
// (scripts/sign-release.mjs) and again before it is uploaded (scripts/publish-release.mjs), checked
// against this checkout. Each step runs on a runner of its own, so neither trusts the files it was
// handed: the build ran esbuild, and the upload runs wrangler. Nothing is rebuilt here: node.mjs and
// inputs.json are checked against the manifest the build job (no secrets, a fresh runner) wrote, and
// launcher.mjs is taken as that job built it.
//
// Only node:crypto, node:fs and node:path (and ./release-key.mjs): scripts/sign-release.mjs imports
// this file, and the release private key never shares a process with third-party code.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fillInstaller, PLACEHOLDER, verifyB64 } from './release-key.mjs';

export const INSTALLERS = ['install.sh', 'install-windows.ps1', 'install-desktop.sh'];
const WASM = join('src', 'sim', 'wasm', 'rocketsim.wasm');

const sha = (b) => createHash('sha256').update(b).digest('hex');

function read(file) {
  try {
    return readFileSync(file);
  } catch {
    throw new Error(`${file} is missing`);
  }
}

/**
 * Check the unsigned build in <dist> against the checkout around <nodes> (nodes/ and its repo) and
 * the release key ({ raw, pem }); throws on the first difference:
 *   - <version>/manifest.json is a production build of nodes/package.json's version: it names its
 *     commit (`commit`, when given: $GITHUB_SHA in CI), and every file it lists, inputs.json
 *     included, matches its size and sha256;
 *   - its wasm is this checkout's src/sim/wasm/rocketsim.wasm, its protocol this checkout's
 *     PROTOCOL_VERSION;
 *   - each installer is exactly nodes/install/<name> filled with the release key: no file of the
 *     build can add a line to what runs as root.
 * Returns { version, rel, manifestBytes, manifest }.
 */
export function checkBuild({ nodes, dist, releaseKey, commit }) {
  const repo = join(nodes, '..');
  const version = JSON.parse(read(join(nodes, 'package.json')).toString('utf8')).version;
  const rel = join(dist, version);
  const manifestBytes = read(join(rel, 'manifest.json'));
  const m = JSON.parse(manifestBytes.toString('utf8'));
  if (m.name !== 'turbogol-node' || m.version !== version) throw new Error(`${rel}/manifest.json is not release ${version}`);
  if (!/^[0-9a-f]{40}$/.test(m.commit ?? '')) throw new Error('manifest.json names no commit: not a production build (node scripts/build-node.mjs, without --sign)');
  if (commit && m.commit !== commit) throw new Error(`manifest.json was built from ${m.commit}, not from this run's commit ${commit}`);
  if (!Array.isArray(m.files) || m.files.length === 0) throw new Error('manifest.json lists no files');
  for (const f of m.files) {
    const b = read(join(rel, f.path));
    if (b.length !== f.size || sha(b) !== f.sha256) throw new Error(`${f.path} does not match manifest.json`);
  }
  if (sha(read(join(rel, 'inputs.json'))) !== m.inputsSha256) throw new Error('inputs.json does not match manifest.json');

  const wasm = sha(read(join(repo, WASM)));
  if (m.wasmSha256 !== wasm || m.files.find((f) => f.path === 'rocketsim.wasm')?.sha256 !== wasm) throw new Error(`manifest.json does not carry this checkout's rocketsim.wasm (${wasm})`);
  const protocol = Number(/PROTOCOL_VERSION = (\d+)/.exec(read(join(repo, 'src', 'net', 'protocol.ts')).toString('utf8'))?.[1]);
  if (m.protocol !== protocol) throw new Error(`manifest.json says protocol ${m.protocol}, this checkout's src/net/protocol.ts ${protocol}`);

  for (const name of INSTALLERS) {
    const built = read(join(dist, name));
    if (built.toString('utf8').includes(PLACEHOLDER)) throw new Error(`${name} still has a ${PLACEHOLDER}* placeholder`);
    const expected = Buffer.from(fillInstaller(read(join(nodes, 'install', name)).toString('utf8'), releaseKey));
    if (!built.equals(expected)) throw new Error(`${name} is not nodes/install/${name} with nodes/release-key.pub filled in`);
  }
  return { version, rel, manifestBytes, manifest: m };
}

/**
 * checkBuild, then what scripts/sign-release.mjs adds: <version>/manifest.sig and launcher.mjs.sig
 * verify with the release key ({ raw, pem, key }), and <version>/release-key.pub is that key.
 */
export function checkSigned({ nodes, dist, releaseKey, commit }) {
  const built = checkBuild({ nodes, dist, releaseKey, commit });
  if (!verifyB64(built.manifestBytes, read(join(built.rel, 'manifest.sig')).toString('utf8'), releaseKey.key)) throw new Error(`${built.version}/manifest.sig does not verify with nodes/release-key.pub`);
  if (!verifyB64(read(join(dist, 'launcher.mjs')), read(join(dist, 'launcher.mjs.sig')).toString('utf8'), releaseKey.key)) throw new Error('launcher.mjs.sig does not verify with nodes/release-key.pub');
  if (read(join(built.rel, 'release-key.pub')).toString('utf8').trim() !== releaseKey.raw) throw new Error(`${built.version}/release-key.pub is not nodes/release-key.pub`);
  return built;
}
