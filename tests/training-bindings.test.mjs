// Training actions in the binding model and the input layer (node --test
// tests/training-bindings.test.mjs): defaults on both devices that collide with no other default,
// listed on the controls screen, edge-triggered on keyboard and pad, rebindable, and filled in for
// settings saved before they existed.
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

const { Input } = await import('../src/input/Input.ts');
const { defaultSettings, mergeSettings } = await import('../src/settings.ts');
const B = await import('../src/input/bindings.ts');
const { emptyControls } = await import('../src/sim/types.ts');

const { GP, DEFAULT_KBM, KEYBOARD_ONLY_KBM, DEFAULT_PAD, ACTION_IDS, ACTION_ROWS, bindingsEqual, bindingLabel } = B;

const TRAINING = ['trainingReset', 'trainingPrev', 'trainingNext', 'trainingResetCar', 'trainingBoost'];

class FakeTarget extends EventTarget {
  key(code) {
    this.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { code }));
  }
  keyUp(code) {
    this.dispatchEvent(Object.assign(new Event('keyup'), { code }));
  }
}

class FakeDocument extends EventTarget {
  constructor() {
    super();
    this.pointerLockElement = null;
    this.visibilityState = 'visible';
  }
  exitPointerLock() {}
}

function makePad() {
  return {
    id: 'Fake Pad (STANDARD GAMEPAD)',
    index: 0,
    connected: true,
    mapping: 'standard',
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    axes: [0, 0, 0, 0],
  };
}

let padList = [];
navigator.getGamepads = () => padList;

function setup(pad = null) {
  padList = pad ? [pad] : [];
  const target = new FakeTarget();
  const settings = defaultSettings();
  const input = new Input(target, settings, { document: new FakeDocument() });
  const out = emptyControls();
  return { input, target, settings, sample: () => input.sample(out) };
}

test('every training action has a default on both devices and is listed on the controls screen', () => {
  for (const a of TRAINING) {
    assert.ok(ACTION_IDS.includes(a), a);
    assert.notEqual(DEFAULT_KBM[a], null, `kbm ${a}`);
    assert.notEqual(KEYBOARD_ONLY_KBM[a], null, `keyboard-only ${a}`);
    assert.notEqual(DEFAULT_PAD[a], null, `pad ${a}`);
    const rows = ACTION_ROWS.filter((r) => r.action === a);
    assert.equal(rows.length, 1, `${a} row`);
    assert.equal(rows[0].group, 'game');
  }
  assert.equal(ACTION_ROWS.length, ACTION_IDS.length, 'every action has exactly one row');
  assert.deepEqual(
    TRAINING.map((a) => [bindingLabel(DEFAULT_KBM[a]), bindingLabel(DEFAULT_PAD[a])]),
    [
      ['Backspace', 'D-pad ↓'],
      ['←', 'D-pad ←'],
      ['→', 'D-pad →'],
      ['↓', 'D-pad ↑'],
      ['↑', 'LB'],
    ],
  );
});

test('no training default shares a key / button with any other default binding', () => {
  for (const [name, profile] of [
    ['default kbm', DEFAULT_KBM],
    ['keyboard-only kbm', KEYBOARD_ONLY_KBM],
    ['default pad', DEFAULT_PAD],
  ]) {
    for (const a of TRAINING) {
      const shared = B.actionsSharingBinding(profile, profile[a], a);
      assert.deepEqual(shared, [], `${name}: ${a} (${bindingLabel(profile[a])}) also bound to ${shared.join(', ')}`);
    }
  }
  // The stick axes (menu navigation and steering) are not D-pad buttons.
  for (const a of ACTION_IDS) {
    if (TRAINING.includes(a)) continue;
    const b = DEFAULT_PAD[a];
    if (b !== null && b.kind === 'gpButton') assert.ok(![GP.DPAD_UP, GP.DPAD_DOWN, GP.DPAD_LEFT, GP.DPAD_RIGHT, GP.LB].includes(b.index), a);
  }
});

test('keyboard edges: Backspace / arrows fire the training actions once per press, never padActions', () => {
  const { input, target, sample } = setup();
  const keys = { Backspace: 'trainingReset', ArrowLeft: 'trainingPrev', ArrowRight: 'trainingNext', ArrowDown: 'trainingResetCar', ArrowUp: 'trainingBoost' };
  for (const [code, action] of Object.entries(keys)) {
    target.key(code);
    sample();
    assert.equal(input.actions[action], true, `${code} -> ${action}`);
    assert.equal(input.padActions[action], false);
    for (const other of TRAINING) if (other !== action) assert.equal(input.actions[other], false, `${code} must not fire ${other}`);
    input.consumeActions();
    sample();
    assert.equal(input.actions[action], false, `${code} held: no repeat`);
    target.keyUp(code);
    sample();
    input.consumeActions();
  }
  // Backspace keeps its fixed menu meaning (pause screen quit) next to the binding.
  target.key('Backspace');
  assert.equal(input.actions.back, true);
  target.keyUp('Backspace');
  input.consumeActions();
  // Training keys drive nothing.
  target.key('ArrowUp');
  const o = emptyControls();
  input.sample(o);
  assert.equal(o.throttle, 0);
  assert.equal(o.pitch, 0);
});

test('pad edges: D-pad and LB fire the training actions (mirrored into padActions)', () => {
  const pad = makePad();
  const { input, sample } = setup(pad);
  const buttons = [
    [GP.DPAD_DOWN, 'trainingReset'],
    [GP.DPAD_LEFT, 'trainingPrev'],
    [GP.DPAD_RIGHT, 'trainingNext'],
    [GP.DPAD_UP, 'trainingResetCar'],
    [GP.LB, 'trainingBoost'],
  ];
  for (const [i, action] of buttons) {
    pad.buttons[i].pressed = true;
    pad.buttons[i].value = 1;
    sample();
    assert.equal(input.actions[action], true, action);
    assert.equal(input.padActions[action], true, action);
    input.consumeActions();
    sample();
    assert.equal(input.padActions[action], false, `${action}: edge only`);
    pad.buttons[i].pressed = false;
    pad.buttons[i].value = 0;
    sample();
    input.consumeActions();
  }
});

test('training actions are rebindable and old saved settings get the new defaults', () => {
  const { input, target, sample } = setup();
  input.setBinding('trainingReset', 'kbm', { kind: 'key', code: 'KeyT' });
  target.key('Backspace');
  sample();
  assert.equal(input.actions.trainingReset, false, 'the old key no longer resets');
  target.keyUp('Backspace');
  input.consumeActions();
  target.key('KeyT');
  sample();
  assert.equal(input.actions.trainingReset, true);
  assert.equal(input.getLabel('trainingReset', 'kbm'), 'T');

  // Settings saved before the training actions existed: the missing ones fall back to the defaults.
  const s = mergeSettings({ bindings: { kbm: { reset: { kind: 'key', code: 'KeyR' } }, pad: { reset: null } } });
  for (const a of TRAINING) {
    assert.ok(bindingsEqual(s.bindings.kbm[a], DEFAULT_KBM[a]), `kbm ${a}`);
    assert.ok(bindingsEqual(s.bindings.pad[a], DEFAULT_PAD[a]), `pad ${a}`);
  }
  // ... and they can be unbound like any action but pause.
  const u = mergeSettings({ bindings: { kbm: { trainingBoost: null }, pad: { trainingNext: null } } });
  assert.equal(u.bindings.kbm.trainingBoost, null);
  assert.equal(u.bindings.pad.trainingNext, null);
});
