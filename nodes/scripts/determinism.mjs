// Cross-machine determinism check. The verifier re-simulates a node's replay on another machine, so
// one build has to give the same ticks on every OS, CPU and Node version. This plays 12 full
// 3-minute matches (1v1, 2v2 and 3v3; the "humans" are the tests' scripted ball chasers, the bots
// are the game's AI; a takeover and an idle slot) and records them exactly like a node does.
//   node scripts/determinism.mjs record <dir>   (from nodes/) records the 12 matches into <dir>
//   node scripts/determinism.mjs verify <dir>   re-simulates the replays another machine recorded
// Record on both machines, copy each <dir> to the other one and verify it there. A replay carries a
// state hash every CHECKPOINT_EVERY ticks, so any difference shows up as a hash mismatch.
// `record` also compares with EXPECTED while the wasm and the protocol are the ones it was taken
// with: there a difference means this machine simulates differently, or the game's rules or bots
// changed since then (then only `verify` between two machines says anything).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { testBuild, playRecordedMatch } from '../test/helpers.mjs';

const { verifyReplay } = await import('../shared/verify.ts');
const { nodeSimFactory } = await import('../shared/nodeArena.ts');

const [cmd, dir] = process.argv.slice(2);
if ((cmd !== 'record' && cmd !== 'verify') || !dir) {
  console.error('usage: node scripts/determinism.mjs record|verify <dir>');
  process.exit(2);
}

// No hostname: the directory travels to the other machine.
const machine = {
  platform: `${os.platform()} ${os.release()}`,
  arch: os.arch(),
  cpu: os.cpus()[0]?.model?.trim(),
  node: process.versions.node,
  v8: process.versions.v8,
};

const P = (slot, team) => ({ slot, team, kind: 'player', name: `P${slot}`, playerId: `${slot}`.repeat(16) });
const B = (slot, team) => ({ slot, team, kind: 'bot', name: `Bot${slot}` });
const LENGTH_SECONDS = 180;

// Changing a case changes its results: EXPECTED then has to be taken again on two machines.
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

// The 12 results at commit dead8ec (2026-10-19), the same on a Windows 11 PC (Ryzen 7 2700, Node
// 24.14.0) and on the Sao Paulo VPS (Linux, EPYC 9355P, Node 24.22.0): [blue, red, end tick, final
// state hash].
const EXPECTED = {
  commit: 'dead8ec',
  wasmSha256: 'c137f952a57395e81e97a187c1a14bed0f034131418deb4bdd4a7b3fdf3f3c92',
  protocol: 3,
  matches: {
    '1v1-human-vs-easy': [0, 2, 22200, 0x3c948480],
    '1v1-human-vs-medium': [2, 3, 25260, 0x63e99dca],
    '1v1-human-vs-hard': [1, 2, 30681, 0xa21a8bbe],
    '1v1-hard-vs-hard': [1, 8, 23880, 0xf1b01123],
    '1v1-human-vs-human': [2, 1, 22440, 0x83181816],
    '2v2-takeover-medium': [0, 1, 33341, 0xfb0670b5],
    '2v2-bots-hard': [3, 1, 22680, 0xbd349c30],
    '3v3-mixed-hard': [2, 0, 22200, 0xa5fab000],
    '3v3-bots-hard': [4, 1, 22920, 0x8def3d77],
    '3v3-bots-medium': [3, 2, 28143, 0xdccd1e63],
    '3v3-bots-easy': [3, 1, 22680, 0x648aafb6],
    '3v3-humans-idle-slot': [1, 2, 24608, 0x8e0ebf9d],
  },
};

const hex = (h) => (h >>> 0).toString(16).padStart(8, '0');

if (cmd === 'record') {
  await mkdir(dir, { recursive: true });
  const build = await testBuild();
  const compare = build.wasmSha256 === EXPECTED.wasmSha256 && build.protocol === EXPECTED.protocol;
  const out = { machine, build, matches: [] };
  let differ = 0;
  for (const c of CASES) {
    const t0 = performance.now();
    const m = await playRecordedMatch({ ...c, lengthSeconds: LENGTH_SECONDS, matchId: c.name.padEnd(32, '0').slice(0, 32) });
    const ms = Math.round(performance.now() - t0);
    const file = `${c.name}.tgr`;
    await writeFile(join(dir, file), m.bytes);
    const finalHash = m.sim.stateHash() >>> 0;
    out.matches.push({ name: c.name, file, bytes: m.bytes.length, end: m.end, finalHash, recordMs: ms });
    let note = '';
    if (compare) {
      const want = EXPECTED.matches[c.name];
      const same = want[0] === m.end.blue && want[1] === m.end.red && want[2] === m.end.tick && want[3] === finalHash;
      if (!same) differ++;
      note = same ? `  = ${EXPECTED.commit}` : `  DIFFERS: ${EXPECTED.commit} gave ${want[0]}-${want[1]} tick ${want[2]} hash ${hex(want[3])}`;
    }
    console.log(`recorded ${c.name.padEnd(22)} ${m.end.blue}-${m.end.red} tick ${m.end.tick} hash ${hex(finalHash)} ${m.bytes.length} B ${ms} ms${note}`);
  }
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(out, null, 2));
  console.log(`machine: ${JSON.stringify(machine)}`);
  if (!compare) {
    console.log(`the wasm or the protocol changed since ${EXPECTED.commit}: no table to compare with; verify between two machines`);
  } else if (differ) {
    console.log(`${differ} of ${CASES.length} differ from ${EXPECTED.commit}: if the rules or the bots changed since then, verify between two machines; if not, this machine simulates differently`);
    process.exit(1);
  } else {
    console.log(`all ${CASES.length} as at ${EXPECTED.commit}`);
  }
} else {
  const man = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  const here = await testBuild();
  console.log(`recorded on: ${JSON.stringify(man.machine)}`);
  console.log(`verifying on: ${JSON.stringify(machine)}`);
  if (here.wasmSha256 !== man.build.wasmSha256 || here.protocol !== man.build.protocol) {
    console.log(`build differs: here ${here.wasmSha256.slice(0, 12)} / protocol ${here.protocol}, recorded ${man.build.wasmSha256.slice(0, 12)} / protocol ${man.build.protocol}`);
    process.exit(1);
  }
  let bad = 0;
  for (const m of man.matches) {
    const bytes = new Uint8Array(await readFile(join(dir, m.file)));
    const v = await verifyReplay(bytes, { makeSim: nodeSimFactory, wasmSha256: here.wasmSha256, protocol: here.protocol });
    const ok = v.code === 'ok' && v.score.blue === m.end.blue && v.score.red === m.end.red && v.ticks === m.end.tick && v.finalHash >>> 0 === m.finalHash;
    if (!ok) bad++;
    const recorded = `recorded ${m.end.blue}-${m.end.red} tick ${m.end.tick} hash ${hex(m.finalHash)}`;
    const why = v.message ? ` (${v.message})` : v.divergedAtTick !== undefined ? ` (diverged at tick ${v.divergedAtTick})` : ok ? '' : ` (${recorded})`;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${m.name.padEnd(22)} ${v.code}${why} ${v.score.blue}-${v.score.red} tick ${v.ticks} hash ${hex(v.finalHash)} verify ${Math.round(v.cpuMs)} ms`);
  }
  console.log(bad ? `${bad} of ${man.matches.length} FAILED` : `all ${man.matches.length} verified`);
  process.exit(bad ? 1 : 0);
}
