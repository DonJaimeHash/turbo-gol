// Render the procedural match music (src/audio/music/engine.ts) offline to a 16-bit stereo WAV, to
// listen to changes without the game: a scripted timeline goes through the menu, play, a goal,
// a pause and the tension mode. Also prints the render speed (its share of one CPU core).
//
//   node scripts/render-music.mjs [out.wav] [--lite] [--seed=N] [--rate=48000]
import { writeFileSync } from 'node:fs';
import { MusicEngine } from '../src/audio/music/engine.ts';

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--')) ?? 'music.wav';
const opt = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? Number(a.split('=')[1]) : def;
};
const sr = opt('rate', 48000);
const lite = args.includes('--lite');

// [time s, action]: state changes and goals, like the game sends them.
const TIMELINE = [
  [0, { mode: 'menu', paused: false }],
  [24, { mode: 'play', paused: false }],
  [70, 'goal'],
  [96, { mode: 'play', paused: true }],
  [102, { mode: 'play', paused: false }],
  [118, { mode: 'tension', paused: false }],
  [150, 'goal'],
  [172, { mode: 'off', paused: false }],
];
const END = 176;

const engine = new MusicEngine(sr, { lite, seed: opt('seed', 0x7a3b) });
const frames = Math.round(END * sr);
const L = new Float32Array(frames);
const R = new Float32Array(frames);
const BLOCK = 128; // an AudioWorklet render quantum
const bl = new Float32Array(BLOCK);
const br = new Float32Array(BLOCK);
let next = 0;
const t0 = performance.now();
for (let f = 0; f < frames; f += BLOCK) {
  while (next < TIMELINE.length && TIMELINE[next][0] * sr <= f) {
    const a = TIMELINE[next++][1];
    if (a === 'goal') engine.goal();
    else engine.setState(a);
  }
  const n = Math.min(BLOCK, frames - f);
  engine.render(bl, br, n);
  L.set(bl.subarray(0, n), f);
  R.set(br.subarray(0, n), f);
}
const ms = performance.now() - t0;

// Stats: peak, RMS, share of one core.
let peak = 0;
let sum = 0;
for (let i = 0; i < frames; i++) {
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  sum += L[i] * L[i] + R[i] * R[i];
}
const rms = Math.sqrt(sum / (2 * frames));
console.log(`${END} s at ${sr} Hz${lite ? ' (lite)' : ''} in ${ms.toFixed(0)} ms: ${((100 * ms) / 1000 / END).toFixed(2)}% of one core; peak ${peak.toFixed(2)}, RMS ${(20 * Math.log10(rms)).toFixed(1)} dBFS`);

// 16-bit PCM WAV.
const buf = Buffer.alloc(44 + frames * 4);
buf.write('RIFF', 0);
buf.writeUInt32LE(36 + frames * 4, 4);
buf.write('WAVEfmt ', 8);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(sr, 24);
buf.writeUInt32LE(sr * 4, 28);
buf.writeUInt16LE(4, 32);
buf.writeUInt16LE(16, 34);
buf.write('data', 36);
buf.writeUInt32LE(frames * 4, 40);
for (let i = 0; i < frames; i++) {
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), 46 + i * 4);
}
writeFileSync(out, buf);
console.log(`wrote ${out}`);
