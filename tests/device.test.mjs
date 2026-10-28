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

test('typedInField: a character, or a keydown with no key (Chrome autofill), in a text field; never throws', () => {
  const input = { tagName: 'INPUT' };
  assert.equal(DEV.typedInField({ target: input, key: 'a' }), true);
  assert.equal(DEV.typedInField({ target: input, key: 'ArrowDown' }), false, 'an arrow says which device');
  assert.equal(DEV.typedInField({ target: input, key: undefined }), true, 'autofill: no key');
  assert.equal(DEV.typedInField({ target: { tagName: 'TEXTAREA' }, key: 'x' }), true);
  assert.equal(DEV.typedInField({ target: { tagName: 'DIV', isContentEditable: true }, key: 'x' }), true);
  assert.equal(DEV.typedInField({ target: { tagName: 'BUTTON' }, key: 'a' }), false);
  assert.equal(DEV.typedInField({ target: { tagName: 'BUTTON' }, key: undefined }), false);
  assert.equal(DEV.typedInField({ target: null, key: 'a' }), false);
  assert.equal(DEV.typedInField({ target: {}, key: 'a' }), false, 'window / document: no tagName');
});

test('layoutClass: by height and orientation, never by width alone; the TV whatever its size', () => {
  assert.equal(DEV.layoutClass(1366, 768, false), 'pc');
  assert.equal(DEV.layoutClass(1920, 1080, false), 'pc');
  assert.equal(DEV.layoutClass(1366, 600, false), 'short');
  assert.equal(DEV.layoutClass(844, 390, false), 'phone');
  assert.equal(DEV.layoutClass(780, 360, false), 'phone');
  assert.equal(DEV.layoutClass(915, 412, false), 'phone', 'a long phone held sideways is no short laptop');
  assert.equal(DEV.layoutClass(820, 560, false), 'pc', 'a small window, sideways');
  assert.equal(DEV.layoutClass(390, 844, false), 'portrait');
  assert.equal(DEV.layoutClass(768, 1024, false), 'tablet');
  assert.equal(DEV.layoutClass(960, 540, true), 'tv');
  assert.equal(DEV.layoutClass(1920, 1080, true), 'tv');
});

test('uiScale: 1 at each class reference view, clamped (PC 0.9 to 1.35, short 0.9 to 1, phone 1 to 1.1, TV 1 to 2)', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  near(DEV.uiScale('pc', 1366, 768), 1);
  near(DEV.uiScale('pc', 1920, 1080), 1.35);
  near(DEV.uiScale('pc', 1280, 720), 720 / 768);
  near(DEV.uiScale('pc', 1280, 640), 0.9);
  // A short laptop is 1 at its own 600 (a 56 bar, 18 px sections), less only when shorter.
  near(DEV.uiScale('short', 1366, 600), 1);
  near(DEV.uiScale('short', 1280, 560), 560 / 600);
  near(DEV.uiScale('short', 1280, 500), 0.9);
  // A phone never under 1: 14 px text and the 123 px rail at 780 x 360 too.
  near(DEV.uiScale('phone', 844, 390), 1);
  near(DEV.uiScale('phone', 780, 360), 1);
  near(DEV.uiScale('phone', 640, 300), 1);
  near(DEV.uiScale('phone', 915, 412), 412 / 390);
  near(DEV.uiScale('portrait', 390, 844), 1);
  near(DEV.uiScale('portrait', 360, 780), 1);
  near(DEV.uiScale('tablet', 768, 1024), 1.1);
  near(DEV.uiScale('tv', 960, 540), 1);
  near(DEV.uiScale('tv', 962, 541), 962 / 960);
  near(DEV.uiScale('tv', 1920, 1080), 2);
  near(DEV.uiScale('tv', 800, 450), 1);
});

test("interface size (Settings > Game): each class's sizes; 0 is the device's own, 125 % on a TV (its usual look); a phone held sideways stops at 115", () => {
  assert.deepEqual(DEV.interfaceSizes('pc', 1366, 768), [100, 115, 130, 150]);
  assert.deepEqual(DEV.interfaceSizes('short', 1366, 600), [100, 115, 130, 150]);
  assert.deepEqual(DEV.interfaceSizes('tablet', 820, 1180), [100, 115, 130]);
  assert.deepEqual(DEV.interfaceSizes('portrait', 390, 844), [100], "a 390 wide phone's bar is full upright");
  assert.deepEqual(DEV.interfaceSizes('portrait', 480, 900), [100, 115]);
  assert.deepEqual(DEV.interfaceSizes('tv', 960, 540), [100, 125]);
  assert.deepEqual(DEV.interfaceSizes('phone', 844, 390), [100, 115]);
  assert.deepEqual(DEV.interfaceSizes('phone', 780, 360), [100], "a 360 tall phone's rail is full");
  assert.equal(DEV.interfaceSize('tv', 0), 125);
  assert.equal(DEV.interfaceSize('pc', 0), 100);
  assert.equal(DEV.interfaceSize('pc', 130), 130);
  assert.equal(DEV.interfaceFactor('tv', 0, 960, 540), 1, "a TV's 125 % is the look it always had");
  assert.equal(DEV.interfaceFactor('tv', 100, 960, 540), 0.8);
  assert.equal(DEV.interfaceFactor('tv', 150, 960, 540), 1, "a computer's 150 on a TV: its own 125");
  assert.equal(DEV.interfaceFactor('pc', 0, 1366, 768), 1);
  assert.equal(DEV.interfaceFactor('pc', 150, 1366, 768), 1.5);
  assert.equal(DEV.interfaceFactor('tablet', 150, 820, 1180), 1.3, 'a save of 150 from a computer: the tablet stops at 130');
  assert.equal(DEV.interfaceFactor('phone', 130, 844, 390), 1.15, 'the same save upright and sideways');
  assert.equal(DEV.interfaceFactor('phone', 115, 780, 360), 1);
});

test('reduced motion: System follows prefers-reduced-motion, Yes always, No never', () => {
  assert.equal(DEV.reducesMotion('system', true), true);
  assert.equal(DEV.reducesMotion('system', false), false);
  assert.equal(DEV.reducesMotion('on', false), true);
  assert.equal(DEV.reducesMotion('off', true), false);
});
