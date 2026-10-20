// The committed wasm hash (src/sim/wasm/rocketsim.sha256.ts) against the committed wasm. The
// Worker cannot hash the wasm it imports (it arrives compiled), and community nodes get matches
// only when their wasm has this hash: a wasm committed without its new hash would leave every node
// without matches. native/build.ps1 rewrites the constant after each build; this checks that the
// rewrite ran, and that the line it looks for is still there.
//   node --test tests/wasm-hash.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const { ROCKETSIM_WASM_SHA256 } = await import('../src/sim/wasm/rocketsim.sha256.ts');

const read = (path, enc) => readFileSync(new URL('../' + path, import.meta.url), enc);

test('ROCKETSIM_WASM_SHA256 is the SHA-256 of src/sim/wasm/rocketsim.wasm (npm run build:wasm rewrites it)', () => {
  const sha = createHash('sha256').update(read('src/sim/wasm/rocketsim.wasm')).digest('hex');
  assert.equal(ROCKETSIM_WASM_SHA256, sha, 'commit src/sim/wasm/rocketsim.sha256.ts with the wasm it describes');
});

test('native/build.ps1 finds the line it rewrites, exactly once', () => {
  const m = /^\$HashLine = "(.+)"\r?$/m.exec(read('native/build.ps1', 'utf8'));
  assert.ok(m, 'build.ps1 declares $HashLine');
  const hits = read('src/sim/wasm/rocketsim.sha256.ts', 'utf8').match(new RegExp(m[1], 'g')) ?? [];
  assert.deepEqual(hits, [`export const ROCKETSIM_WASM_SHA256 = '${ROCKETSIM_WASM_SHA256}';`]);
});
