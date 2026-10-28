// The music tracks (src/audio/music/tracks/) and the engine that plays them: every track's data is
// well formed, and it renders finite, bounded, seed-deterministic audio through the game's modes.
// Run: node --test tests/music.test.mjs
// Node strips the types of .ts files natively; src imports are extensionless (what tsc/Vite want),
// so a resolve hook maps them to the .ts file before the module is loaded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
const { TRACKS, DEFAULT_TRACK, trackById } = await import('../src/audio/music/tracks/index.ts');

const isPc = (n) => Number.isInteger(n) && n >= 0 && n < 12;
const isStep = (n) => Number.isInteger(n) && n >= 0 && n < 16;

test('track ids are unique and the default is listed', () => {
  const ids = TRACKS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(TRACKS.includes(DEFAULT_TRACK));
  assert.equal(trackById('no-such-track'), DEFAULT_TRACK);
});

for (const track of TRACKS) {
  test(`${track.id}: the data is well formed`, () => {
    assert.ok(track.bpm >= 60 && track.bpm <= 200, 'bpm');
    assert.ok(track.progressions.length > 0);
    for (const prog of track.progressions) {
      assert.equal(prog.length, 4, 'four chords per progression (one per bar)');
      for (const c of prog) {
        assert.equal(c.pad.length, 3, 'three pad notes');
        assert.equal(c.pcs.length, 3, 'three chord tones');
        assert.ok(c.pcs.every(isPc), 'pitch classes 0-11');
        if (c.alter !== undefined) assert.ok(c.alter.every(isPc) && c.pcs.includes(c.alter[1]), 'alter into a chord tone');
      }
    }
    assert.ok(track.leadScale.length >= 5);
    for (let i = 1; i < track.leadScale.length; i++) assert.ok(track.leadScale[i] > track.leadScale[i - 1], 'lead scale ascending');
    for (const m of [...track.motifs, ...track.cadences]) {
      assert.ok(m.length >= 2 && m.length % 2 === 0, 'motifs are [step, length] pairs');
      for (let i = 0; i < m.length; i += 2) assert.ok(isStep(m[i]) && m[i + 1] > 0 && m[i] + m[i + 1] <= 16, 'a motif note fits its bar');
    }
    assert.ok(track.motifs.length > 0 && track.cadences.length > 0);
    assert.equal(track.brokenKick.length, 4);
    assert.ok(track.brokenKick.every((bar) => bar.every(isStep)));
    assert.equal(track.bassPattern.length % 3, 0, 'bass pattern triples');
    for (let i = 0; i < track.bassPattern.length; i += 3) assert.ok(isStep(track.bassPattern[i]) && track.bassPattern[i + 2] > 0);
    assert.equal(track.arpOrder.length, 16);
    const sections = [...track.forms.menu, ...track.forms.play, ...track.forms.tension, track.goal, track.afterGoal.play, track.afterGoal.tension];
    for (const mode of ['menu', 'play', 'tension']) assert.ok(track.forms[mode].length > 0, `a ${mode} form`);
    for (const s of sections) {
      assert.ok(s.bars >= 1 && s.riser <= s.bars, 'bars and riser');
      assert.ok(s.prog >= 0 && s.prog < track.progressions.length, 'progression index');
    }
  });

  test(`${track.id}: renders bounded, finite, seed-deterministic audio through the modes`, () => {
    const sr = 24000;
    const render = (seed) => {
      const e = new MusicEngine(sr, track, { seed });
      const timeline = [
        [0, { mode: 'menu', paused: false }],
        [4, { mode: 'play', paused: false }],
        [10, 'goal'],
        [14, { mode: 'play', paused: true }],
        [15, { mode: 'tension', paused: false }],
        [20, { mode: 'off', paused: false }],
      ];
      const frames = Math.ceil((28 * sr) / 128) * 128; // whole render quanta; off lands on a bar, then fades
      const L = new Float32Array(frames);
      const R = new Float32Array(frames);
      const bl = new Float32Array(128);
      const br = new Float32Array(128);
      let next = 0;
      for (let f = 0; f < frames; f += 128) {
        while (next < timeline.length && timeline[next][0] * sr <= f) {
          const a = timeline[next++][1];
          if (a === 'goal') e.goal();
          else e.setState(a);
        }
        e.render(bl, br, 128);
        L.set(bl, f);
        R.set(br, f);
      }
      return { L, R, active: e.active };
    };
    const a = render(1);
    let peak = 0;
    let energy = 0;
    for (let i = 0; i < a.L.length; i++) {
      assert.ok(Number.isFinite(a.L[i]) && Number.isFinite(a.R[i]), 'finite samples');
      peak = Math.max(peak, Math.abs(a.L[i]), Math.abs(a.R[i]));
      energy += a.L[i] * a.L[i];
    }
    assert.ok(peak <= 1, 'within full scale');
    assert.ok(energy / a.L.length > 1e-4, 'not silent');
    assert.equal(a.active, false, 'silent and idle after off');
    assert.deepEqual(render(1).L, a.L, 'the same seed renders the same music');
  });
}
