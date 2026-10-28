// Settings validation (node --test tests/settings.test.mjs): mergeSettings must never let corrupt
// localStorage data reach Input (bit masks / table indices) or leave the game without a pause key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (!specifier.startsWith('.') || /\.[cm]?ts$/.test(specifier)) throw err;
      return nextResolve(specifier.replace(/\.js$/, '') + '.ts', context);
    }
  },
});

const { mergeSettings, defaultSettings, DEFAULT_AUDIO, DEFAULT_CAMERA, DEFAULT_CONTROL_SETTINGS, VOLUME_RANGE } = await import('../src/settings.ts');
const { DEFAULT_KBM, DEFAULT_PAD, GP_MAX_BUTTONS, GP_MAX_AXES, MAX_MOUSE_BUTTON } = await import('../src/input/bindings.ts');

test('mouse buttons and pad indices must be whole numbers in range (1 << 32 aliases LMB)', () => {
  const s = mergeSettings({
    bindings: {
      kbm: {
        boost: { kind: 'mouse', button: 32 },
        jump: { kind: 'mouse', button: NaN },
        powerslide: { kind: 'mouse', button: -1 },
        airRoll: { kind: 'mouse', button: 1.5 },
        ballCam: { kind: 'mouse', button: MAX_MOUSE_BUTTON + 1 },
        rearView: { kind: 'mouse', button: 4 },
      },
      pad: {
        boost: { kind: 'gpButton', index: GP_MAX_BUTTONS },
        jump: { kind: 'gpButton', index: -1 },
        powerslide: { kind: 'gpAxis', index: GP_MAX_AXES, sign: 1 },
        airRoll: { kind: 'gpAxis', index: 2.5, sign: -1 },
        ballCam: { kind: 'gpAxis', index: 1, sign: 0 },
        rearView: { kind: 'gpAxis', index: GP_MAX_AXES - 1, sign: 1 },
        reset: { kind: 'gpButton', index: GP_MAX_BUTTONS - 1 },
      },
    },
  });
  for (const a of ['boost', 'jump', 'powerslide', 'airRoll', 'ballCam']) {
    assert.deepEqual(s.bindings.kbm[a], DEFAULT_KBM[a], `kbm ${a} falls back`);
    assert.deepEqual(s.bindings.pad[a], DEFAULT_PAD[a], `pad ${a} falls back`);
  }
  assert.deepEqual(s.bindings.kbm.rearView, { kind: 'mouse', button: 4 });
  assert.deepEqual(s.bindings.pad.rearView, { kind: 'gpAxis', index: GP_MAX_AXES - 1, sign: 1 });
  assert.deepEqual(s.bindings.pad.reset, { kind: 'gpButton', index: GP_MAX_BUTTONS - 1 });
});

test('pause stays bound on both devices; every other action can be unbound', () => {
  const s = mergeSettings({ bindings: { kbm: { pause: null, reset: null }, pad: { pause: null, boost: null } } });
  assert.deepEqual(s.bindings.kbm.pause, DEFAULT_KBM.pause);
  assert.equal(s.bindings.kbm.reset, null);
  assert.deepEqual(s.bindings.pad.pause, DEFAULT_PAD.pause);
  assert.equal(s.bindings.pad.boost, null);
});

test('wrong-device bindings, empty key codes and garbage fall back; numbers clamp to their ranges', () => {
  const s = mergeSettings({
    controls: { mouseSensitivity: 99, steeringSensitivity: -4, vibration: 'yes', mouseSteering: true, dodgeDeadzone: NaN },
    camera: { fov: 'x', distance: 1e9 },
    bindings: {
      kbm: { jump: { kind: 'gpButton', index: 0 }, boost: { kind: 'key', code: '' }, powerslide: 'ShiftLeft', airRoll: { kind: 'laser' } },
      pad: { jump: { kind: 'key', code: 'Space' }, boost: { kind: 'mouseAxis', axis: 'x', sign: 1 } },
      other: 'ignored',
    },
  });
  assert.equal(s.controls.mouseSensitivity, 10);
  assert.equal(s.controls.steeringSensitivity, 1);
  assert.equal(s.controls.dodgeDeadzone, DEFAULT_CONTROL_SETTINGS.dodgeDeadzone);
  assert.equal(s.controls.vibration, true);
  assert.equal(s.controls.mouseSteering, true);
  assert.equal(s.camera.fov, DEFAULT_CAMERA.fov);
  assert.equal(s.camera.distance, 400);
  for (const a of ['jump', 'boost', 'powerslide', 'airRoll']) assert.deepEqual(s.bindings.kbm[a], DEFAULT_KBM[a], a);
  for (const a of ['jump', 'boost']) assert.deepEqual(s.bindings.pad[a], DEFAULT_PAD[a], a);
  assert.deepEqual(mergeSettings(null), defaultSettings());
  assert.deepEqual(mergeSettings('garbage'), defaultSettings());
  assert.deepEqual(mergeSettings({ bindings: { kbm: null, pad: 3 } }), defaultSettings());
});

test('valid saved bindings of every kind survive the merge', () => {
  const kbm = {
    throttle: { kind: 'key', code: 'ArrowUp' },
    jump: { kind: 'mouse', button: 3 },
    ballCam: { kind: 'wheel', sign: -1 },
    lookLeft: { kind: 'mouseAxis', axis: 'y', sign: 1 },
  };
  const pad = { jump: { kind: 'gpButton', index: 5 }, throttle: { kind: 'gpAxis', index: 1, sign: -1 } };
  const s = mergeSettings({ bindings: { kbm, pad } });
  for (const [a, b] of Object.entries(kbm)) assert.deepEqual(s.bindings.kbm[a], b, a);
  for (const [a, b] of Object.entries(pad)) assert.deepEqual(s.bindings.pad[a], b, a);
  assert.deepEqual(s.bindings.kbm.boost, DEFAULT_KBM.boost, 'untouched actions keep the default');
});

test('the master volume is a number in 0..100 (%); anything else falls back to the default', () => {
  const vol = (audio) => mergeSettings({ audio }).audio.volume;
  assert.equal(vol({ volume: 35 }), 35);
  assert.equal(vol({ volume: 0 }), 0, 'muted is a valid choice');
  assert.equal(vol({ volume: 150 }), 100);
  assert.equal(vol({ volume: -5 }), 0);
  for (const bad of ['loud', NaN, Infinity, null, true]) assert.equal(vol({ volume: bad }), DEFAULT_AUDIO.volume, String(bad));
  assert.equal(vol(null), DEFAULT_AUDIO.volume);
  assert.equal(vol(7), DEFAULT_AUDIO.volume);
  assert.deepEqual(mergeSettings({}).audio, DEFAULT_AUDIO);
  assert.deepEqual(defaultSettings().audio, DEFAULT_AUDIO);
  assert.notEqual(defaultSettings().audio, DEFAULT_AUDIO, 'a copy: the settings screen writes into it');
  const [min, max, step] = VOLUME_RANGE;
  assert.equal(min, 0);
  assert.equal(max, 100);
  assert.equal((max - min) % step, 0, 'the slider reaches both ends');
  assert.equal(DEFAULT_AUDIO.volume % step, 0, 'the default sits on the slider grid');
});

const { DEFAULT_TOUCH, DEFAULT_UI, TOUCH_OPACITY_RANGE, TOUCH_DEADZONE_RANGE } = await import('../src/settings.ts');

test('PR 11 groups are additive: a save from before them loads unchanged, its new groups at their defaults', () => {
  const old = {
    controls: { ...DEFAULT_CONTROL_SETTINGS, steeringSensitivity: 2, touchHoldJump: true },
    camera: { ...DEFAULT_CAMERA, fov: 95 },
    audio: { volume: 40 },
    bindings: { kbm: { boost: { kind: 'key', code: 'KeyF' } } },
    rev: 2,
  };
  const s = mergeSettings(JSON.parse(JSON.stringify(old)));
  assert.equal(s.controls.steeringSensitivity, 2);
  assert.equal(s.controls.touchHoldJump, true);
  assert.equal(s.camera.fov, 95);
  assert.equal(s.audio.volume, 40);
  assert.deepEqual(s.bindings.kbm.boost, { kind: 'key', code: 'KeyF' });
  assert.deepEqual(s.touch, DEFAULT_TOUCH);
  assert.deepEqual(s.ui, DEFAULT_UI);
  assert.deepEqual(DEFAULT_UI, { size: 0, motion: 'system' }, "the interface size: the device's own");
  assert.deepEqual(defaultSettings().touch, { size: 'M', opacity: 100, lefty: false, stick: 'floating', deadzone: 0.12, vibration: true }, "today's controls");
});

test('touch and interface settings: valid values kept, a missing key reads its default, garbage falls back field by field', () => {
  const s = mergeSettings({ touch: { size: 'L', opacity: 55, lefty: true, stick: 'fixed', deadzone: 0.2, vibration: false }, ui: { size: 150, motion: 'on' } });
  assert.deepEqual(s.touch, { size: 'L', opacity: 55, lefty: true, stick: 'fixed', deadzone: 0.2, vibration: false });
  assert.deepEqual(s.ui, { size: 150, motion: 'on' });
  const partial = mergeSettings({ touch: { lefty: true }, ui: { motion: 'off' } });
  assert.deepEqual(partial.touch, { ...DEFAULT_TOUCH, lefty: true });
  assert.deepEqual(partial.ui, { ...DEFAULT_UI, motion: 'off' });
  const bad = mergeSettings({ touch: { size: 'XL', opacity: 5, lefty: 'yes', stick: 'free', deadzone: 9, vibration: 1 }, ui: { size: 120, motion: true } });
  assert.deepEqual(bad.touch, { ...DEFAULT_TOUCH, opacity: TOUCH_OPACITY_RANGE[0], deadzone: TOUCH_DEADZONE_RANGE[1] });
  assert.deepEqual(bad.ui, DEFAULT_UI);
  assert.deepEqual(mergeSettings({ touch: null, ui: 'big' }).touch, DEFAULT_TOUCH);
});

test('the music volume sits beside PR 11 groups: a save from before either loads unchanged, the rest at defaults', () => {
  const music = (audio) => mergeSettings({ audio }).audio.music;
  assert.equal(music({ music: 25 }), 25);
  assert.equal(music({ music: 0 }), 0, 'no music is a valid choice');
  assert.equal(music({ music: 140 }), 100);
  for (const bad of ['loud', NaN, null, true]) assert.equal(music({ music: bad }), DEFAULT_AUDIO.music, String(bad));
  assert.deepEqual(DEFAULT_AUDIO, { volume: 70, music: 50 });
  assert.equal(DEFAULT_AUDIO.music % VOLUME_RANGE[2], 0, 'the default sits on the slider grid');
  // Before the music: PR 11's groups saved, no audio.music.
  const noMusic = mergeSettings({ audio: { volume: 40 }, touch: { size: 'L', lefty: true }, ui: { size: 115, motion: 'on' }, rev: 2 });
  assert.deepEqual(noMusic.audio, { volume: 40, music: DEFAULT_AUDIO.music });
  assert.deepEqual(noMusic.touch, { ...DEFAULT_TOUCH, size: 'L', lefty: true });
  assert.deepEqual(noMusic.ui, { size: 115, motion: 'on' });
  // Before PR 11: the music saved, no touch or ui group.
  const noPr11 = mergeSettings({ audio: { volume: 40, music: 15 }, rev: 2 });
  assert.deepEqual(noPr11.audio, { volume: 40, music: 15 });
  assert.deepEqual(noPr11.touch, DEFAULT_TOUCH);
  assert.deepEqual(noPr11.ui, DEFAULT_UI);
  // Every group saved together comes back as it was.
  const all = mergeSettings({ audio: { volume: 35, music: 80 }, touch: { size: 'S', opacity: 60, lefty: true, stick: 'fixed', deadzone: 0.2, vibration: false }, ui: { size: 150, motion: 'off' } });
  assert.deepEqual(mergeSettings(JSON.parse(JSON.stringify(all))), all);
  assert.deepEqual(defaultSettings().audio, DEFAULT_AUDIO);
});
