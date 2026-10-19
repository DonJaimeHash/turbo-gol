// Build the browser WebRTC harness:
//   web/dist/rtc-harness.js   client/harness.ts + the game's NetClient + the WebRTC socket adapter,
//                             one ESM bundle for the browser (inline source map)
//
//   node scripts/build-web.mjs
// web/rtc-harness.html loads it; the dev control plane serves both at /web/rtc-harness.html.
// esbuild comes from the repo's server/node_modules, exactly like scripts/build-node.mjs.
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepoRoot } from './repo-root.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = findRepoRoot(root);
const require = createRequire(import.meta.url);
const esbuild = require(join(repo, 'server', 'node_modules', 'esbuild'));

const entry = join(root, 'client', 'harness.ts');
const outfile = join(root, 'web', 'dist', 'rtc-harness.js');
await mkdir(dirname(outfile), { recursive: true });

await esbuild.build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: 'inline',
  legalComments: 'inline',
  logLevel: 'warning',
});

const out = await readFile(outfile);
const mapAt = out.lastIndexOf('//# sourceMappingURL=data:');
const code = mapAt >= 0 ? mapAt : out.length;
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`${relative(root, outfile).replace(/\\/g, '/')}  ${kb(out.length)} (code ${kb(code)}, inline source map ${kb(out.length - code)})`);
console.log('open <control>/web/rtc-harness.html (add ?auto=1 to start on load)');
