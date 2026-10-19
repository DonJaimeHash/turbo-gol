// Cross-machine determinism check for community-node verification.
// Records full 3-minute matches on this machine (humans are the tests' scripted ball chasers,
// bots are the real AI) and verifies replays recorded on another machine. From nodes/ (or with
// npm run xmachine -- <args>):
//
//   node scripts/xmachine.mjs record <outDir> [<nodes dir>]
//   node scripts/xmachine.mjs verify <inDir> [<nodes dir>]
//
// Record on one machine, copy the directory (the .tgr files and manifest.json) to the other and
// verify it there; then the other way round. <nodes dir> is the package whose code runs, this
// script's own by default.
//
// With no copy at all: `record` also compares each match (final state hash, replay size, score,
// end tick) with scripts/xmachine-reference.json, a recording made on the project's PC (Windows,
// Node 24.14.0), whenever that reference is for the same wasm. A difference exits 1. A change to
// the bots or the rules leaves the wasm as it is and makes the reference stale: after one, record
// on the PC and copy its manifest.json over the reference; to tell a stale reference from a
// machine that simulates differently, verify the copied replays as above.
//
// A replay carries a state hash every CHECKPOINT_EVERY ticks: verifying it re-simulates every tick
// (physics in the wasm, bots and rules in JavaScript) and compares each hash, the score and the
// end tick. Any cross-machine difference shows up as a hash mismatch.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';

const [cmd, dir, nodesDir = fileURLToPath(new URL('..', import.meta.url))] = process.argv.slice(2);
if (!cmd || !dir) {
  console.error('usage: node scripts/xmachine.mjs record|verify <dir> [<nodes dir>]');
  process.exit(2);
}
const imp = (p) => import(pathToFileURL(join(nodesDir, p)).href);
const H = await imp('test/helpers.mjs'); // registers the .ts resolve hook first
const { verifyReplay } = await imp('shared/verify.ts');
const { nodeSimFactory } = await imp('shared/nodeArena.ts');

// No host name: a manifest becomes the committed reference.
const machine = {
  platform: `${os.platform()} ${os.release()}`,
  arch: os.arch(),
  cpu: os.cpus()[0]?.model?.trim(),
  node: process.versions.node,
  v8: process.versions.v8,
};

const P = (slot, team) => ({ slot, team, kind: 'player', name: `P${slot}`, playerId: `${slot}`.repeat(16) });
const B = (slot, team) => ({ slot, team, kind: 'bot', name: `Bot${slot}` });
const LEN = 180;

const CASES = [
  { name: '1v1-human-vs-easy', mode: '1v1', roster: [P(0, 0), B(1, 1)], botDifficulty: 'easy', seed: 11 },
  { name: '1v1-human-vs-medium', mode: '1v1', roster: [P(0, 0), B(1, 1)], botDifficulty: 'medium', seed: 12, underrunEvery: 7 },
  { name: '1v1-human-vs-hard', mode: '1v1', roster: [P(0, 0), B(1, 1)], botDifficulty: 'hard', seed: 13 },
  { name: '1v1-hard-vs-hard', mode: '1v1', roster: [B(0, 0), B(1, 1)], botDifficulty: 'hard', seed: 14 },
  { name: '1v1-human-vs-human', mode: '1v1', roster: [P(0, 0), P(1, 1)], botDifficulty: 'medium', seed: 15 },
  { name: '2v2-takeover-medium', mode: '2v2', roster: [P(0, 0), P(1, 0), P(2, 1), B(3, 1)], botDifficulty: 'medium', seed: 21, takeovers: [{ tick: 9000, slot: 1 }] },
  { name: '2v2-bots-hard', mode: '2v2', roster: [B(0, 0), B(1, 0), B(2, 1), B(3, 1)], botDifficulty: 'hard', seed: 22 },
  { name: '3v3-mixed-hard', mode: '3v3', roster: [P(0, 0), P(1, 0), B(2, 0), P(3, 1), B(4, 1), B(5, 1)], botDifficulty: 'hard', seed: 31 },
  { name: '3v3-bots-hard', mode: '3v3', roster: [B(0, 0), B(1, 0), B(2, 0), B(3, 1), B(4, 1), B(5, 1)], botDifficulty: 'hard', seed: 32 },
  { name: '3v3-bots-medium', mode: '3v3', roster: [B(0, 0), B(1, 0), B(2, 0), B(3, 1), B(4, 1), B(5, 1)], botDifficulty: 'medium', seed: 33 },
  { name: '3v3-bots-easy', mode: '3v3', roster: [B(0, 0), B(1, 0), B(2, 0), B(3, 1), B(4, 1), B(5, 1)], botDifficulty: 'easy', seed: 34 },
  { name: '3v3-humans-idle-slot', mode: '3v3', roster: [P(0, 0), P(1, 0), P(2, 0), P(3, 1), P(4, 1), P(5, 1)], botDifficulty: 'medium', seed: 35, idleSlots: { 4: 12000 } },
];

if (cmd === 'record') {
  await mkdir(dir, { recursive: true });
  const out = { machine, build: await H.testBuild(), matches: [] };
  for (const c of CASES) {
    const t0 = performance.now();
    const m = await H.playRecordedMatch({ ...c, lengthSeconds: LEN, matchId: c.name.padEnd(32, '0').slice(0, 32) });
    const ms = performance.now() - t0;
    const file = `${c.name}.tgr`;
    await writeFile(join(dir, file), m.bytes);
    const finalHash = m.sim.stateHash() >>> 0;
    out.matches.push({ name: c.name, file, bytes: m.bytes.length, end: m.end, finalHash, recordMs: Math.round(ms) });
    console.log(`recorded ${c.name.padEnd(22)} ${m.end.blue}-${m.end.red} ${m.end.reason} tick ${m.end.tick} hash ${finalHash.toString(16)} ${m.bytes.length} B ${Math.round(ms)} ms`);
  }
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(machine));
  const ref = await readFile(join(nodesDir, 'scripts', 'xmachine-reference.json'), 'utf8').then(JSON.parse, () => null);
  if (!ref) {
    console.log('no scripts/xmachine-reference.json: nothing to compare with');
  } else if (ref.build.wasmSha256 !== out.build.wasmSha256 || ref.build.protocol !== out.build.protocol) {
    console.log(`the reference is for another build (${ref.build.wasmSha256}/${ref.build.protocol}): not compared`);
  } else {
    const fields = (m) => (m ? `hash ${(m.finalHash >>> 0).toString(16)} ${m.bytes} B ${m.end.blue}-${m.end.red} ${m.end.reason} tick ${m.end.tick}` : 'none');
    let differ = 0;
    for (const m of out.matches) {
      const r = ref.matches.find((x) => x.name === m.name);
      const same = !!r && r.finalHash === m.finalHash && r.bytes === m.bytes && JSON.stringify(r.end) === JSON.stringify(m.end);
      if (same) continue;
      differ++;
      console.log(`DIFFERS ${m.name}: here ${fields(m)}, reference ${fields(r)}`);
    }
    const on = `${ref.machine.platform}, ${ref.machine.cpu}, Node ${ref.machine.node}`;
    console.log(differ ? `${differ} of ${out.matches.length} differ from the reference recorded on ${on}` : `all ${out.matches.length} match the reference recorded on ${on}`);
    if (differ) process.exit(1);
  }
} else if (cmd === 'verify') {
  const man = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  const here = await H.testBuild();
  console.log(`recorded on: ${JSON.stringify(man.machine)}`);
  console.log(`verifying on: ${JSON.stringify(machine)}`);
  if (here.wasmSha256 !== man.build.wasmSha256 || here.protocol !== man.build.protocol) {
    console.log(`BUILD DIFFERS: here ${here.wasmSha256}/${here.protocol}, recorded ${man.build.wasmSha256}/${man.build.protocol}`);
    process.exit(1);
  }
  let bad = 0;
  for (const m of man.matches) {
    const bytes = new Uint8Array(await readFile(join(dir, m.file)));
    const v = await verifyReplay(bytes, { makeSim: nodeSimFactory, wasmSha256: here.wasmSha256, protocol: here.protocol });
    const scoreOk = v.score && v.score.blue === m.end.blue && v.score.red === m.end.red && v.ticks === m.end.tick;
    const ok = v.code === 'ok' && scoreOk;
    if (!ok) bad++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${m.name.padEnd(22)} ${v.code}${v.message ? ` (${v.message})` : ''} score ${v.score ? `${v.score.blue}-${v.score.red}` : '?'} ticks ${v.ticks} verify ${Math.round(v.cpuMs ?? 0)} ms`);
  }
  console.log(bad ? `${bad} of ${man.matches.length} FAILED` : `all ${man.matches.length} verified`);
  process.exit(bad ? 1 : 0);
} else {
  console.error(`unknown command ${cmd}`);
  process.exit(2);
}
