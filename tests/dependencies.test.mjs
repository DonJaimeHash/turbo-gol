// Dependency hygiene: Dependabot watches every npm package of the repo (the root, server/ and the
// community node program in nodes/), and the server's lockfile is past the undici advisories its
// wrangler / miniflare carried (the audit's repo-6: undici 7.29.1, fixed in 7.30.1; wrangler
// 4.153.0 is the first that also bundles the fixed one). server/test/tooling.test.mjs checks the
// installed copies. Reads files only.
//   node --test tests/dependencies.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

function cmp(a, b) {
  const pa = a.split(/[.-]/).slice(0, 3).map(Number);
  const pb = b.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/** The `updates` of .github/dependabot.yml as [{ ecosystem, directory }] (the file's own simple shape). */
function dependabotUpdates() {
  const out = [];
  for (const block of read('.github/dependabot.yml').split(/\n\s*-\s+package-ecosystem:\s*/).slice(1)) {
    const ecosystem = block.split('\n')[0].trim();
    const directory = /\n\s+directory:\s*(\S+)/.exec(block)?.[1];
    out.push({ ecosystem, directory });
  }
  return out;
}

test('Dependabot watches every npm package of the repo, and the workflow actions', () => {
  const r = spawnSync('git', ['ls-files', '--', 'package-lock.json', '*/package-lock.json'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const dirs = r.stdout
    .split('\n')
    .filter(Boolean)
    .map((f) => '/' + dirname(f).replace(/^\.$/, '').replaceAll('\\', '/'))
    .map((d) => (d === '/' ? '/' : d.replace(/\/$/, '')));
  assert.ok(dirs.includes('/nodes'), 'nodes/ has a lockfile');
  const updates = dependabotUpdates();
  const npm = updates.filter((u) => u.ecosystem === 'npm').map((u) => u.directory);
  for (const d of dirs) assert.ok(npm.includes(d), `.github/dependabot.yml has no npm entry for ${d}`);
  assert.ok(updates.some((u) => u.ecosystem === 'github-actions' && u.directory === '/'));
});

test("the server's lockfile is past undici 7.29's advisories, in wrangler's bundle too", () => {
  const lock = JSON.parse(read('server/package-lock.json'));
  const undici = Object.entries(lock.packages).filter(([k]) => /(^|\/)node_modules\/undici$/.test(k));
  assert.ok(undici.length > 0);
  for (const [k, p] of undici) assert.ok(cmp(p.version, '7.30.1') >= 0, `${k} ${p.version}`);
  const wrangler = lock.packages['node_modules/wrangler']?.version;
  assert.ok(wrangler && cmp(wrangler, '4.153.0') >= 0, `wrangler ${wrangler} bundles undici 7.29.1 (4.153.0 is the first with 7.30.1)`);
  // A lockfile-only update: server/package.json is a node release input and keeps its ranges.
  const pkg = JSON.parse(read('server/package.json'));
  assert.deepEqual(lock.packages[''].devDependencies, pkg.devDependencies);
});
