// Review fixes in the verifier: every ending needs its proof in the replay, takeovers need a
// relayed leave, a 'ttl' only in overtime, and the verdict carries what the control plane rates
// and rewards from (end reason, proven leaves, present ticks).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { T, P, playRecordedMatch, roster1v1, testBuild } from './helpers.mjs';

const { decodeReplay, ReplayWriter } = await import('../shared/replay.ts');
const { verifyReplay, presentTicks, ABSENT_TICKS, EMPTY_PROOF_TICKS } = await import('../shared/verify.ts');
const { nodeSimFactory } = await import('../shared/nodeArena.ts');

async function verifyOpts(extra = {}) {
  const b = await testBuild();
  return { makeSim: nodeSimFactory, wasmSha256: b.wasmSha256, protocol: P.PROTOCOL_VERSION, ...extra };
}

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

const A = 'a'.repeat(16);
const B = 'b'.repeat(16);

test("'left' needs every human's takeover, and every takeover needs a relayed leave", async () => {
  const m = await playRecordedMatch({ roster: roster1v1(true, true), lengthSeconds: 60, stopAt: 900, endReason: 'left' });
  const bare = await verifyReplay(m.bytes, await verifyOpts());
  assert.equal(bare.code, 'end_mismatch', "a node cannot stop a match as 'left' while both players are in it");
  const both = rewrite(m.bytes, (r) => r.takeovers.push({ tick: r.end.tick + 1, slot: 0 }, { tick: r.end.tick + 1, slot: 1 }));
  const ok = await verifyReplay(both, await verifyOpts({ leaves: [A, B] }));
  assert.equal(ok.code, 'ok', ok.message);
  assert.equal(ok.endReason, 'left');
  assert.deepEqual(ok.leftSlots, [0, 1]);
  const invented = await verifyReplay(both, await verifyOpts({ leaves: [A] }));
  assert.equal(invented.code, 'bad_takeover', 'B never asked to leave');
});

test('a forfeit by leaving is only proven by a relayed leave', async () => {
  const m = await playRecordedMatch({ roster: roster1v1(true, true), lengthSeconds: 60, stopAt: 700, endReason: 'forfeit', forfeitTeam: 1 });
  const withTakeover = rewrite(m.bytes, (r) => r.takeovers.push({ tick: r.end.tick + 1, slot: 1 }));
  assert.equal((await verifyReplay(withTakeover, await verifyOpts({ leaves: [B] }))).code, 'ok');
  const v = await verifyReplay(withTakeover, await verifyOpts({ leaves: [] }));
  assert.equal(v.code, 'bad_takeover', 'the review case: red never left, the node invented the takeover');
});

test("'empty' needs every human gone for the proof window", async () => {
  const stop = 2000;
  const gone = await playRecordedMatch({ roster: roster1v1(true, true), lengthSeconds: 60, idleSlots: { 0: stop - EMPTY_PROOF_TICKS - 10, 1: stop - EMPTY_PROOF_TICKS - 10 }, stopAt: stop, endReason: 'empty' });
  const ok = await verifyReplay(gone.bytes, await verifyOpts());
  assert.equal(ok.code, 'ok', ok.message);
  const still = await playRecordedMatch({ roster: roster1v1(true, true), lengthSeconds: 60, idleSlots: { 0: stop - 400 }, stopAt: stop, endReason: 'empty' });
  assert.equal((await verifyReplay(still.bytes, await verifyOpts())).code, 'end_mismatch', 'red was still playing');
});

test("'ttl' is refused while regulation is still running", async () => {
  // 20 s of regulation + a 1 s countdown: tick 2410 is still regulation.
  const m = await playRecordedMatch({ roster: roster1v1(true, false), lengthSeconds: 20, stopAt: 2410, endReason: 'ttl' });
  assert.equal(m.end.reason, 'ttl', 'this seed is still in regulation at tick 2410');
  const v = await verifyReplay(m.bytes, await verifyOpts());
  assert.equal(v.code, 'end_mismatch');
  assert.match(v.message, /overtime/);
});

test('the verdict carries the end reason and each slot’s present ticks (disconnects excluded)', async () => {
  const stop = 6000;
  const idleFrom = 2000;
  const m = await playRecordedMatch({ roster: roster1v1(true, true), lengthSeconds: 120, idleSlots: { 1: idleFrom }, stopAt: stop, endReason: 'left' });
  const r = decodeReplay(m.bytes);
  const present = presentTicks(r, r.end.tick);
  assert.equal(present[0], stop, 'blue played the whole match');
  assert.ok(present[1] < idleFrom && present[1] > idleFrom - ABSENT_TICKS, `red counted until it went idle (${present[1]})`);
  // A rules ending reports its reason; the control plane rates from this field.
  const rules = await playRecordedMatch({ roster: roster1v1(true, false), lengthSeconds: 10 });
  assert.equal(rules.end.reason, 'rules');
  const v = await verifyReplay(rules.bytes, await verifyOpts());
  assert.equal(v.code, 'ok', v.message);
  assert.equal(v.endReason, 'rules');
  assert.equal(v.presentTicks.length, 2);
  assert.equal(v.presentTicks[1], 0, 'bots earn nothing');
});

test('re-simulation yields to the event loop when asked', async () => {
  const m = await playRecordedMatch({ roster: roster1v1(true, false), lengthSeconds: 10 });
  let yields = 0;
  const v = await verifyReplay(m.bytes, await verifyOpts({ yieldFn: () => new Promise((res) => setImmediate(() => res(yields++))) }));
  assert.equal(v.code, 'ok');
  assert.ok(yields >= Math.floor(m.end.tick / 240) - 1, `${yields} yields for ${m.end.tick} ticks`);
});

test('a verifier given its release only accepts replays recorded on that release', async () => {
  const m = await playRecordedMatch({ roster: roster1v1(true, false), lengthSeconds: 10 });
  const b = await testBuild();
  assert.equal((await verifyReplay(m.bytes, await verifyOpts({ version: b.version }))).code, 'ok');
  const other = await verifyReplay(m.bytes, await verifyOpts({ version: '9.9.9' }));
  assert.equal(other.code, 'build_mismatch', 'same wasm and protocol, another node release');
});
