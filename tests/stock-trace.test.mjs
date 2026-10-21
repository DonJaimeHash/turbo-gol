// The golden stock trace (scripts/stock-trace.mjs): the committed wasm and bots must reproduce, hash
// for hash, the runs recorded in tests/fixtures/stock-trace.json with the wasm from before the
// physics mutators (c137f952). Stock physics is what ranked, casual, server matches, community nodes,
// training packs and replays run; identical hashes are why this wasm needs no PROTOCOL_VERSION bump.
//   node --test tests/stock-trace.test.mjs      (needs src/sim/wasm/rocketsim.{js,wasm})
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { runStockTrace, readFixture, SCENARIOS } = await import('../scripts/stock-trace.mjs');
const { RocketSim } = await import('../src/sim/RocketSimBridge.ts');
const { buildArenaMesh } = await import('../src/sim/arenaMesh.ts');

const fixture = readFixture();

function assertSameTrace(got, name, how) {
  const want = fixture.scenarios.find((s) => s.name === name);
  assert.ok(want, `${name} is in the fixture`);
  assert.equal(got.hashes.length, want.hashes.length, `${name} ${how}: number of checkpoints`);
  for (let i = 0; i < want.hashes.length; i++) {
    assert.equal(got.hashes[i], want.hashes[i], `${name} ${how}: state hash differs at second ${i + 1}`);
    assert.equal(got.predHashes[i], want.predHashes[i], `${name} ${how}: ball prediction differs at second ${i + 1}`);
  }
  assert.deepEqual([got.goals, got.bumps, got.demos], [want.goals, want.bumps, want.demos], `${name} ${how}: events`);
}

for (const name of SCENARIOS) {
  test(`golden stock trace ${name}: the committed wasm reproduces the recorded hashes`, async () => {
    assertSameTrace(await runStockTrace(name), name, 'stock');
  });
}

test('golden stock trace: a second, fresh module instance reproduces it too', async () => {
  const sim = await RocketSim.load();
  sim.initArena(buildArenaMesh().physics);
  assertSameTrace(await runStockTrace('random-2v2', { sim }), 'random-2v2', 'second instance');
});
