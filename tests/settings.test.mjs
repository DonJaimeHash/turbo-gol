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

const { mergeSettings, defaultSettings, DEFAULT_CAMERA, DEFAULT_CONTROL_SETTINGS } = await import('../src/settings.ts');
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
