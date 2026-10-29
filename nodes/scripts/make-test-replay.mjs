// A replay to try the viewer with (replay.html): a match played and recorded on a RoomHost exactly
// like a node does (test/helpers.mjs playRecordedMatch: scripted ball chasers as the humans).
//   node nodes/scripts/make-test-replay.mjs [out.tgr] [1v1|2v2] [seconds]
// Default: replays-dev/test.tgr (git-ignored, never in public/: a build would ship it), then open
// http://localhost:5173/replay.html?file=/replays-dev/test.tgr (the ?file= flag exists only under npm run dev)
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { playRecordedMatch, roster1v1, roster2v2 } from '../test/helpers.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(process.argv[2] ?? `${root}/replays-dev/test.tgr`);
const mode = process.argv[3] === '2v2' ? '2v2' : '1v1';
const lengthSeconds = Number(process.argv[4] ?? 60);

const t0 = performance.now();
const { bytes, end } = await playRecordedMatch({
  roster: mode === '2v2' ? roster2v2() : roster1v1(true, false),
  mode,
  lengthSeconds,
  seed: 1234,
  countdown: 3,
  goalPause: 3,
});
await mkdir(dirname(out), { recursive: true });
await writeFile(out, bytes);
console.log(`${out}: ${bytes.length} bytes, ${mode}, ${end.blue}-${end.red} (${end.reason}) at tick ${end.tick}, ${Math.round(performance.now() - t0)} ms`);
