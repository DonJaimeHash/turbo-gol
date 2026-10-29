// The server's own tooling, as installed: wrangler runs `wrangler dev`, every deploy and the
// node-release upload with the R2 token, and it carries undici twice, once as miniflare's
// dependency and once bundled inside wrangler-dist/cli.js (so the lockfile alone cannot show it).
// Both must be past the advisories fixed in undici 7.30.1 (GHSA-xjj6-f33q-929c and the others of
// the audit's repo-6). No network; reads server/node_modules. An install that is not this
// lockfile's (a checkout sharing another one's node_modules) is skipped: CI runs npm ci first.
// Run from server/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('..', import.meta.url));
const UNDICI_FLOOR = '7.30.1';

/** -1, 0 or 1 for two x.y.z versions (a prerelease tag is ignored). */
function cmp(a, b) {
  const pa = a.split(/[.-]/).slice(0, 3).map(Number);
  const pb = b.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

const lock = JSON.parse(readFileSync(join(SERVER, 'package-lock.json'), 'utf8'));
const installedVersion = (name) => {
  try {
    return JSON.parse(readFileSync(join(SERVER, 'node_modules', name, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
};
const stale = ['wrangler', 'miniflare', 'undici'].filter((n) => installedVersion(n) !== lock.packages[`node_modules/${n}`]?.version);
const skip = stale.length > 0 ? `node_modules is not this lockfile's install (${stale.join(', ')}): npm ci` : false;

test("wrangler's bundled undici is past the 7.29 advisories", { skip }, () => {
  const cli = readFileSync(join(SERVER, 'node_modules', 'wrangler', 'wrangler-dist', 'cli.js'), 'utf8');
  const bundled = [...new Set([...cli.matchAll(/undici@(\d+\.\d+\.\d+)/g)].map((m) => m[1]))];
  assert.ok(bundled.length > 0, 'wrangler-dist/cli.js names the undici it bundles');
  for (const v of bundled) assert.ok(cmp(v, UNDICI_FLOOR) >= 0, `wrangler bundles undici ${v} (< ${UNDICI_FLOOR})`);
});

test('every undici installed for the server is past the 7.29 advisories', { skip }, () => {
  const found = Object.entries(lock.packages).filter(([k]) => /(^|\/)node_modules\/undici$/.test(k));
  assert.ok(found.length > 0, 'the lockfile has undici');
  for (const [k, p] of found) assert.ok(cmp(p.version, UNDICI_FLOOR) >= 0, `${k} ${p.version} (< ${UNDICI_FLOOR})`);
  const installed = installedVersion('undici');
  assert.ok(installed !== null && cmp(installed, UNDICI_FLOOR) >= 0, `node_modules/undici ${installed}`);
});
