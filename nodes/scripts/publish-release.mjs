// Upload a signed node release (scripts/sign-release.mjs) to the R2 bucket turbogol-node-releases,
// served at /nodes/releases/. CI runs it in the upload job of .github/workflows/node-release.yml,
// on a runner that never gets the release key, after `npm ci --ignore-scripts` in server/: the
// locked wrangler is the only third-party code that job runs.
//
//   node scripts/publish-release.mjs [--dist dist/releases]
//
// Before it uploads anything, it checks the release again (./release-check.mjs): every file against
// the signed manifest, both signatures and <version>/release-key.pub against nodes/release-key.pub,
// the wasm and the protocol against this checkout, and the installers (not signed, and they run as
// root) byte for byte against nodes/install/ filled with release-key.pub. Then:
//   - A version is published once: launchers keep the releases they downloaded and verification
//     compares versions, so one version must always mean the same bytes. <version>/manifest.json in
//     R2 with other bytes stops it. With the same bytes (a re-run of the upload job gets the same
//     signed artifact), an earlier run stopped half-way, and it uploads everything again.
//   - manifest.json goes last in its version: until it is there, nothing reads the rest.
//   - launcher.mjs, launcher.mjs.sig and the installers have no version in their path, and every new
//     install downloads them: they come from the newest release published (latest.json names it), so
//     an older version published later (a fix on an older line) leaves them alone.
//   - Everything it uploaded is read back and compared.
// Never channel.json: the deploy gate moves the channel (scripts/node-release-gate.mjs at the repo
// root). R2 goes through ./channel.mjs (wrangler, always --remote) with the credentials in the
// environment.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compareVersions, isVersion, wranglerR2 } from './channel.mjs';
import { checkSigned, INSTALLERS } from './release-check.mjs';
import { readReleaseKey } from './release-key.mjs';
import { findRepoRoot } from './repo-root.mjs';

const TYPES = { '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json' };
/** Without --content-type, R2 objects have no type. */
const typeOf = (key) => TYPES[/\.[a-z0-9]+$/.exec(key)?.[0]] ?? 'text/plain; charset=utf-8';

/** The release launcher.mjs and the installers in R2 come from (latest.json), or null before the first. */
function readLatest(r2) {
  const b = r2.get('latest.json');
  if (!b) return null;
  let version;
  try {
    version = JSON.parse(b.toString('utf8')).version;
  } catch {
    version = null;
  }
  if (!isVersion(version)) throw new Error('latest.json in R2 names no X.Y.Z version: fix it before publishing');
  return version;
}

/**
 * Check the signed release in <dist> against the checkout around <nodes> (nodes/ and its repo) and
 * upload it through `r2` (wranglerR2 of ./channel.mjs). `commit`: the commit the release must name
 * ($GITHUB_SHA in CI). Returns { version, keys } (what it uploaded, in order).
 */
export function publishRelease({ nodes, dist, r2, commit, env = process.env, log = console.log }) {
  if (env.TGN_RELEASE_PRIVATE_KEY) throw new Error('TGN_RELEASE_PRIVATE_KEY is set: the upload runs wrangler, and the release key belongs to the sign job alone');
  const releaseKey = readReleaseKey(join(nodes, 'release-key.pub'));
  const { version, manifestBytes, manifest } = checkSigned({ nodes, dist, releaseKey, commit });

  const published = r2.get(`${version}/manifest.json`);
  if (published && !published.equals(manifestBytes)) throw new Error(`release ${version} is already in R2, with another manifest.json: a version is published once. Raise the version in nodes/package.json and tag that`);
  if (published) log(`release ${version} is already in R2 with this manifest.json: an earlier upload stopped half-way, uploading it all again`);
  const latest = readLatest(r2);
  const newer = latest && compareVersions(latest, version) > 0 ? latest : null;

  const keys = [...manifest.files.map((f) => f.path), 'manifest.sig', 'release-key.pub', 'inputs.json', 'manifest.json'].map((f) => `${version}/${f}`);
  // The launcher and its signature back to back: in between, new installs refuse the launcher.
  if (!newer) keys.push('launcher.mjs', 'launcher.mjs.sig', ...INSTALLERS);
  const uploads = keys.map((key) => [key, readFileSync(join(dist, key))]);
  if (!newer) uploads.push(['latest.json', Buffer.from(`${JSON.stringify({ version }, null, 2)}\n`)]);
  for (const [key, bytes] of uploads) {
    r2.put(key, bytes, typeOf(key));
    log(`  ${key}`);
  }
  for (const [key, bytes] of uploads) {
    if (!r2.get(key)?.equals(bytes)) throw new Error(`${key} does not read back from R2 as it was uploaded`);
  }
  log(
    newer
      ? `published release ${version}; launcher.mjs and the installers stay those of ${newer}, the newest release in R2`
      : `published release ${version}, with its launcher.mjs and installers (latest.json: ${version})`,
  );
  return { version, keys: uploads.map(([key]) => key) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const nodes = join(dirname(fileURLToPath(import.meta.url)), '..');
  const i = process.argv.indexOf('--dist');
  try {
    if (i > 0 && !process.argv[i + 1]) throw new Error('--dist needs a value');
    const dist = resolve(i > 0 ? process.argv[i + 1] : join(nodes, 'dist', 'releases'));
    publishRelease({ nodes, dist, r2: wranglerR2({ server: join(findRepoRoot(nodes), 'server') }), commit: process.env.GITHUB_SHA });
  } catch (e) {
    console.error(`publish-release: ${e.message}`);
    process.exit(1);
  }
}
