// Find the Turbogol repo root from inside this package, wherever the package lives
// (nodes/ in the repo): the first ancestor that holds the
// game's wasm.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function findRepoRoot(start) {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'src', 'sim', 'wasm', 'rocketsim.wasm')) && existsSync(join(dir, 'server'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`Turbogol repo root not found above ${start}`);
}
