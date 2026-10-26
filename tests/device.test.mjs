// The input device decisions of the menus (src/ui/device.ts), pure: the last input (pad, remote,
// keyboard, mouse, touch), the TV class, the 450 ms tap guard.
//   node --test tests/device.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (relative && err && err.code === 'ERR_MODULE_NOT_FOUND' && !/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + '.ts', context);
      throw err;
    }
  },
});

const DEV = await import('../src/ui/device.ts');

test('tapGuarded: a finger down before the mount or within 450 ms after it presses nothing; later ones do', () => {
  assert.equal(DEV.TAP_GUARD_MS, 450);
  assert.equal(DEV.tapGuarded(990, 1000), true, 'went down before the screen came');
  assert.equal(DEV.tapGuarded(1200, 1000), true, 'a double tap 200 ms after');
  assert.equal(DEV.tapGuarded(1449, 1000), true);
  assert.equal(DEV.tapGuarded(1450, 1000), false, 'a real tap');
  assert.equal(DEV.tapGuarded(5, -Infinity), false, 'nothing mounted yet');
});

test('keyInput: the remote is the arrows / OK / Back on a TV with no controller; else the keyboard; silent keys say nothing', () => {
  assert.equal(DEV.keyInput('ArrowDown', 'ArrowDown', true, false), 'remote');
  assert.equal(DEV.keyInput('Enter', 'Enter', true, false), 'remote');
  assert.equal(DEV.keyInput('', 'GoBack', true, false), 'remote', 'Android TV BACK');
  assert.equal(DEV.keyInput('BrowserBack', 'BrowserBack', true, false), 'remote');
  assert.equal(DEV.keyInput('ArrowDown', 'ArrowDown', true, true), 'keyboard', 'a controller is connected: a real keyboard');
  assert.equal(DEV.keyInput('KeyQ', 'q', true, false), 'keyboard', 'letters are a keyboard, even on a TV');
  assert.equal(DEV.keyInput('ArrowDown', 'ArrowDown', false, false), 'keyboard');
  assert.equal(DEV.keyInput('', 'GoBack', false, false), null, 'a back key off a TV says nothing');
  for (const code of ['', 'AudioVolumeUp', 'MediaPlayPause', 'ShiftLeft', 'ControlRight', 'AltLeft', 'MetaLeft', 'BrowserHome', 'LaunchApp1', 'CapsLock']) {
    assert.equal(DEV.keyInput(code, 'x', true, false), null, code);
    assert.equal(DEV.keyInput(code, 'x', false, false), null, code);
  }
  assert.equal(DEV.keyInput(undefined, undefined, false, false), null);
});

test('pointerInput, isTv and initialInput', () => {
  assert.equal(DEV.pointerInput('mouse'), 'mouse');
  assert.equal(DEV.pointerInput('touch'), 'touch');
  assert.equal(DEV.pointerInput('pen'), 'touch');
  assert.equal(DEV.pointerInput(''), null);
  assert.equal(DEV.isTv('none', false), true, 'no pointer at all: a TV');
  assert.equal(DEV.isTv('fine', false), false);
  assert.equal(DEV.isTv('coarse', false), false);
  assert.equal(DEV.isTv('fine', true), true, '#tv');
  assert.equal(DEV.initialInput('none', false), 'remote');
  assert.equal(DEV.initialInput('coarse', false), 'touch');
  assert.equal(DEV.initialInput('fine', false), 'mouse');
  assert.equal(DEV.initialInput('fine', true), 'remote');
});

test('DeviceTracker: the last input, a change notified once, pad presses counted per frame', () => {
  const d = new DEV.DeviceTracker('mouse');
  const seen = [];
  d.subscribe((k) => seen.push(k));
  assert.equal(d.note(null), false);
  assert.equal(d.note('mouse'), false, 'no change');
  assert.equal(d.note('keyboard'), true);
  d.notePadPresses(0);
  assert.equal(d.lastInput, 'keyboard', 'no press yet');
  d.notePadPresses(3);
  assert.equal(d.lastInput, 'pad');
  d.note('touch');
  d.notePadPresses(3);
  assert.equal(d.lastInput, 'touch', 'the same count is no new press');
  d.notePadPresses(4);
  assert.deepEqual(seen, ['keyboard', 'pad', 'touch', 'pad']);
});
