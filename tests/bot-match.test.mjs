// Headless bot-vs-bot matches through scripts/smoke-match.mjs (wasm + analytic arena, BotTeam vs
// BotTeam): the script exits non-zero when the ball barely moves, when anything leaves the arena,
// when the ball sits still for more than 10 s (the 3v3 dead-ball deadlock) or when the bots score
// too many own goals. One 100 s run per team size at hard; ~2 s each.
//   node --test tests/bot-match.test.mjs      (needs src/sim/wasm/rocketsim.{js,wasm}: npm run build:wasm)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/smoke-match.mjs', import.meta.url));
const TICKS = 12000;

for (const mode of ['1v1', '2v2', '3v3']) {
  test(`smoke match ${mode} hard, ${TICKS} ticks: ball keeps moving, nothing leaves the arena, no own-goal streak`, () => {
    const r = spawnSync(process.execPath, [script, mode, 'hard', String(TICKS)], { encoding: 'utf8', timeout: 120_000 });
    const tail = (r.stdout + r.stderr).trim().split('\n').slice(-6).join('\n');
    assert.equal(r.status, 0, `${mode}: smoke-match.mjs exited with ${r.status}\n${tail}`);
    assert.match(r.stdout, /^OK: ball moved/m, `${mode}: no OK line\n${tail}`);
  });
}
