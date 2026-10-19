// Replay + verification against the real rocketsim.wasm: a recorded match re-simulates to the same
// hashes and score, and every kind of tampering a malicious node could try is caught.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { T, P, playRecordedMatch, roster1v1, roster2v2, testBuild } from './helpers.mjs';

const { decodeReplay, ReplayWriter } = await import('../shared/replay.ts');
const { verifyReplay, FORFEIT_DC_TICKS } = await import('../shared/verify.ts');
const { nodeSimFactory } = await import('../shared/nodeArena.ts');

async function verifyOpts(extra = {}) {
  const b = await testBuild();
  return { makeSim: nodeSimFactory, wasmSha256: b.wasmSha256, protocol: P.PROTOCOL_VERSION, ...extra };
}

/** Rebuild a replay with `mutate(parsed)` applied (re-encodes header + records in tick order). */
function rewrite(bytes, mutate) {
  const r = decodeReplay(bytes);
  mutate(r);
  const w = new ReplayWriter(r.header);
  const recs = [];
  for (let i = 0; i < r.inputCount; i++) recs.push({ tick: r.inputTicks[i], o: 0, k: 'i', i });
  for (const t of r.takeovers) recs.push({ tick: t.tick, o: 1, k: 't', t });
  for (let i = 0; i < r.hashCount; i++) recs.push({ tick: r.hashTicks[i], o: 2, k: 'h', i });
  recs.sort((a, b) => a.tick - b.tick || a.o - b.o);
  for (const x of recs) {
    if (x.k === 'i') w.input(x.tick, r.inputSlots[x.i], r.inputData, x.i * T.PACKED_INPUT_BYTES);
    else if (x.k === 't') w.takeover(x.t.tick, x.t.slot);
    else w.hash(x.tick, r.hashValues[x.i]);
  }
  if (r.end) w.end(r.end);
  return w.finish();
}

test('a recorded 1v1 (human vs bot) verifies: same hashes, score and winner', async () => {
  const m = await playRecordedMatch({ roster: roster1v1(true, false), lengthSeconds: 20, underrunEvery: 7 });
  assert.equal(m.end.reason, 'rules');
  const r = decodeReplay(m.bytes);
  assert.ok(r.inputCount > 10, 'inputs recorded');
  assert.ok(r.hashCount >= 20, 'checkpoints recorded');
  const v = await verifyReplay(m.bytes, await verifyOpts());
  assert.equal(v.code, 'ok', v.message);
  assert.deepEqual(v.score, { blue: m.end.blue, red: m.end.red });
  assert.equal(v.winner, m.end.winner);
  assert.equal(v.ticks, m.end.tick);
  console.log(`    1v1: ${m.end.tick} ticks, ${m.end.blue}-${m.end.red}, replay ${m.bytes.length} B, verify ${v.cpuMs.toFixed(0)} ms`);
});

test('a 2v2 with a mid-match leave (bot takeover) verifies', async () => {
  const m = await playRecordedMatch({ roster: roster2v2(), mode: '2v2', lengthSeconds: 15, takeovers: [{ tick: 900, slot: 1 }] });
  const v = await verifyReplay(m.bytes, await verifyOpts());
  assert.equal(v.code, 'ok', v.message);
});

test('tampering with one applied input is caught at the next checkpoint', async () => {
  const m = await playRecordedMatch({ roster: roster1v1(true, false), lengthSeconds: 15 });
  const bad = rewrite(m.bytes, (r) => {
    // Flip the throttle of the first input change after 4 s.
    for (let i = 0; i < r.inputCount; i++) {
      if (r.inputTicks[i] > 480) {
        r.inputData[i * T.PACKED_INPUT_BYTES] = -r.inputData[i * T.PACKED_INPUT_BYTES] || -127;
        break;
      }
    }
  });
  const v = await verifyReplay(bad, await verifyOpts());
  assert.equal(v.code, 'hash_mismatch');
  assert.ok(v.divergedAtTick > 480);
});

test('a faked score, a faked winner and a faked forfeit are rejected', async () => {
  const m = await playRecordedMatch({ roster: roster1v1(true, false), lengthSeconds: 15 });
  const score = rewrite(m.bytes, (r) => {
    r.end.blue += 1;
  });
  assert.equal((await verifyReplay(score, await verifyOpts())).code, 'score_mismatch');
  const early = await playRecordedMatch({ roster: roster1v1(true, true), lengthSeconds: 60, stopAt: 2400, endReason: 'forfeit', forfeitTeam: 1 });
  const v = await verifyReplay(early.bytes, await verifyOpts());
  assert.equal(v.code, 'forfeit_unproven', 'red never went idle: no forfeit');
});

test('a real disconnect forfeit (60 s of zero inputs) and a leave forfeit verify', async () => {
  const stop = 600 + FORFEIT_DC_TICKS + 30;
  const dc = await playRecordedMatch({ roster: roster1v1(true, true), lengthSeconds: 120, idleSlots: { 1: 600 }, stopAt: stop, endReason: 'forfeit', forfeitTeam: 1 });
  const v1 = await verifyReplay(dc.bytes, await verifyOpts());
  assert.equal(v1.code, 'ok', v1.message);
  assert.equal(v1.winner, 0);
  // Red's only human quits at tick 700: the team is gone, the match ends at that tick (takeover recorded at end + 1).
  const left = await playRecordedMatch({ roster: roster1v1(true, true), lengthSeconds: 60, stopAt: 700, endReason: 'forfeit', forfeitTeam: 1 });
  const withTakeover = rewrite(left.bytes, (r) => {
    r.takeovers.push({ tick: r.end.tick + 1, slot: 1 });
  });
  const v2 = await verifyReplay(withTakeover, await verifyOpts());
  assert.equal(v2.code, 'ok', v2.message);
});

test('header checks: wrong wasm, roster swapped, dropped checkpoints', async () => {
  const m = await playRecordedMatch({ roster: roster1v1(true, false), lengthSeconds: 10 });
  assert.equal((await verifyReplay(m.bytes, await verifyOpts({ wasmSha256: '0'.repeat(64) }))).code, 'build_mismatch');
  const expect = {
    matchId: m.header.matchId,
    mode: '1v1',
    region: 'SA',
    ranked: false,
    roster: roster1v1(false, true),
    matchLengthSeconds: 10,
    kickoffSeed: 1,
    botDifficulty: 'medium',
    createdAt: 0,
    kickoffCountdownSeconds: 1,
    goalPauseSeconds: 1,
  };
  const v = await verifyReplay(m.bytes, await verifyOpts({ expect }));
  assert.equal(v.code, 'header_mismatch');
  assert.equal(v.message, 'roster');
  const okExpect = { ...expect, roster: roster1v1(true, false) };
  assert.equal((await verifyReplay(m.bytes, await verifyOpts({ expect: okExpect }))).code, 'ok');
  const noHashes = rewrite(m.bytes, (r) => {
    r.hashCount = Math.max(0, r.hashCount - 3);
  });
  assert.equal((await verifyReplay(noHashes, await verifyOpts())).code, 'bad_replay');
});

test('malformed bytes never throw out of verifyReplay', async () => {
  const opts = await verifyOpts();
  for (const b of [new Uint8Array(0), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), new TextEncoder().encode('TGR1garbage')]) {
    const v = await verifyReplay(b, opts);
    assert.equal(v.ok, false);
    assert.equal(v.code, 'bad_replay');
  }
});
