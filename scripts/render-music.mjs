// Render a music track (src/audio/music/tracks/) offline to a 16-bit stereo WAV, to listen to
// changes without the game: a scripted timeline goes through the menu, play, a goal, a pause and
// the tension mode. Also prints the render speed (its share of one CPU core).
//
//   node scripts/render-music.mjs [out.wav] [--track=id] [--lite] [--seed=N] [--rate=48000]
//
// Node strips the types of .ts files natively; src imports are extensionless (what tsc/Vite want),
// so a resolve hook maps them to the .ts file before the module is loaded.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (!specifier.startsWith('.') || /\.[cm]?ts$/.test(specifier)) throw err;
      return nextResolve(specifier + '.ts', context);
    }
  },
});

const { MusicEngine } = await import('../src/audio/music/engine.ts');
const { TRACKS, trackById } = await import('../src/audio/music/tracks/index.ts');

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--')) ?? 'music.wav';
const opt = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : def;
};
const sr = Number(opt('rate', 48000));
const lite = args.includes('--lite');
const trackId = opt('track', undefined);
if (trackId !== undefined && !TRACKS.some((t) => t.id === trackId)) {
  console.error(`unknown track "${trackId}"; tracks: ${TRACKS.map((t) => t.id).join(', ')}`);
  process.exit(1);
}
const track = trackById(trackId);

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

const engine = new MusicEngine(sr, track, { lite, seed: Number(opt('seed', 0x7a3b)) });
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
console.log(`${track.id}: ${END} s at ${sr} Hz${lite ? ' (lite)' : ''} in ${ms.toFixed(0)} ms: ${((100 * ms) / 1000 / END).toFixed(2)}% of one core; peak ${peak.toFixed(2)}, RMS ${(20 * Math.log10(rms)).toFixed(1)} dBFS`);

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
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, buf);
console.log(`wrote ${out}`);
