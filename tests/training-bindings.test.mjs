// Training actions in the binding model and the input layer (node --test
// tests/training-bindings.test.mjs): defaults on both devices that collide with no other default
// (the arrows' second driving keys included: the arrows drive, the training keys left them),
// listed on the controls screen, edge-triggered on keyboard and pad, rebindable, filled in for
// settings saved before they existed, and moved off the arrows for settings saved before rev 2.
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

const { GP, DEFAULT_KBM, KEYBOARD_ONLY_KBM, DEFAULT_PAD, KBM_SECONDARY, LEGACY_TRAINING_KBM, ACTION_IDS, ACTION_ROWS, bindingsEqual, bindingLabel } = B;

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
      ['PgUp', 'D-pad ←'],
      ['PgDn', 'D-pad →'],
      ['F', 'D-pad ↑'],
      ['T', 'LB'],
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
  // Nor with the arrows (second driving keys) or R (reset to kickoff).
  const secondary = new Set(Object.values(KBM_SECONDARY));
  for (const profile of [DEFAULT_KBM, KEYBOARD_ONLY_KBM]) {
    for (const a of TRAINING) {
      const b = profile[a];
      assert.equal(b.kind, 'key', a);
      assert.ok(!secondary.has(b.code), `${a} on an arrow`);
      assert.notEqual(b.code, 'KeyR', a);
    }
  }
  // The stick axes (menu navigation and steering) are not D-pad buttons.
  for (const a of ACTION_IDS) {
    if (TRAINING.includes(a)) continue;
    const b = DEFAULT_PAD[a];
    if (b !== null && b.kind === 'gpButton') assert.ok(![GP.DPAD_UP, GP.DPAD_DOWN, GP.DPAD_LEFT, GP.DPAD_RIGHT, GP.LB].includes(b.index), a);
  }
});

test('keyboard edges: Backspace / PgUp / PgDn / F / T fire the training actions once per press, never padActions', () => {
  const { input, target, sample } = setup();
  const keys = { Backspace: 'trainingReset', PageUp: 'trainingPrev', PageDown: 'trainingNext', KeyF: 'trainingResetCar', KeyT: 'trainingBoost' };
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
  // Backspace keeps its fixed menu meaning (back: the pause screen resumes) next to the binding.
  target.key('Backspace');
  assert.equal(input.actions.back, true);
  target.keyUp('Backspace');
  input.consumeActions();
  // Training keys drive nothing; the arrows fire no training action.
  target.key('KeyT');
  const o = emptyControls();
  input.sample(o);
  assert.equal(o.throttle, 0);
  assert.equal(o.pitch, 0);
  target.keyUp('KeyT');
  input.consumeActions();
  for (const code of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
    target.key(code);
    input.sample(o);
    for (const a of TRAINING) assert.equal(input.actions[a], false, `${code} must not fire ${a}`);
    target.keyUp(code);
    input.sample(o);
    input.consumeActions();
  }
});

test('the arrows drive like W A S D (second keys), on the ground and in the air, and give way to a binding of their own', () => {
  const { input, target } = setup();
  const o = emptyControls();
  const drive = (code) => {
    target.key(code);
    input.sample(o);
    const r = { throttle: o.throttle, steer: o.steer, pitch: o.pitch, yaw: o.yaw };
    target.keyUp(code);
    input.sample(o);
    input.consumeActions();
    return r;
  };
  const wasd = { ArrowUp: 'KeyW', ArrowDown: 'KeyS', ArrowLeft: 'KeyA', ArrowRight: 'KeyD' };
  for (const [arrow, letter] of Object.entries(wasd)) {
    const a = drive(arrow);
    assert.deepEqual(a, drive(letter), `${arrow} = ${letter}`);
    assert.ok(a.throttle !== 0 || a.steer !== 0, `${arrow} drives`);
  }
  assert.equal(drive('ArrowUp').throttle, 1);
  assert.equal(drive('ArrowDown').throttle, -1);
  // W and ↑ together are still one full throttle (summed and clamped).
  target.key('KeyW');
  target.key('ArrowUp');
  input.sample(o);
  assert.equal(o.throttle, 1);
  target.keyUp('KeyW');
  target.keyUp('ArrowUp');
  input.sample(o);
  // The player binds ↑ to boost: ↑ boosts and no longer drives.
  input.setBinding('boost', 'kbm', { kind: 'key', code: 'ArrowUp' });
  target.key('ArrowUp');
  input.sample(o);
  assert.equal(o.boost, true);
  assert.equal(o.throttle, 0);
  target.keyUp('ArrowUp');
  input.sample(o);
  // A rebound throttle keeps ↑ as its second key; the other arrows still steer.
  input.resetBindings('kbm');
  input.setBinding('throttle', 'kbm', { kind: 'key', code: 'KeyI' });
  assert.equal(drive('ArrowUp').throttle, 1);
  assert.equal(drive('KeyI').throttle, 1);
  assert.equal(drive('KeyW').throttle, 0, 'W is no longer the throttle');
  assert.ok(drive('ArrowLeft').steer < 0);
  // Every second key is an arrow and drives only throttle / steer / pitch / yaw.
  for (const [action, code] of Object.entries(KBM_SECONDARY)) {
    assert.ok(code.startsWith('Arrow'), action);
    assert.ok(['throttle', 'reverse', 'steerLeft', 'steerRight', 'pitchUp', 'pitchDown', 'yawLeft', 'yawRight'].includes(action), action);
  }
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

test('settings saved before rev 2: training keys still on their old arrows move to the new defaults, choices stay', () => {
  const key = (code) => ({ kind: 'key', code });
  const oldKbm = { trainingPrev: key('ArrowLeft'), trainingNext: key('ArrowRight'), trainingResetCar: key('ArrowDown'), trainingBoost: key('ArrowUp') };
  for (const [a, code] of Object.entries(LEGACY_TRAINING_KBM)) assert.deepEqual(oldKbm[a], key(code), a);
  // No rev: the old defaults.
  const s = mergeSettings({ bindings: { kbm: { ...oldKbm, trainingReset: key('KeyY'), boost: key('ArrowUp') } } });
  for (const a of Object.keys(LEGACY_TRAINING_KBM)) assert.ok(bindingsEqual(s.bindings.kbm[a], DEFAULT_KBM[a]), a);
  assert.deepEqual(s.bindings.kbm.trainingReset, key('KeyY'), 'not an arrow default: kept');
  assert.deepEqual(s.bindings.kbm.boost, key('ArrowUp'), 'only the training actions move');
  // A training key moved elsewhere before rev 2 is a choice: kept.
  assert.deepEqual(mergeSettings({ bindings: { kbm: { trainingBoost: key('KeyB') } } }).bindings.kbm.trainingBoost, key('KeyB'));
  // Saved at rev 2 or later: an arrow there is the player's own pick.
  const r = mergeSettings({ rev: 2, bindings: { kbm: oldKbm } });
  for (const [a, b] of Object.entries(oldKbm)) assert.deepEqual(r.bindings.kbm[a], b, a);
});

test('settings saved before rev 2: a training key whose new default the player already uses stays on its arrow', () => {
  const key = (code) => ({ kind: 'key', code });
  const oldKbm = { trainingPrev: key('ArrowLeft'), trainingNext: key('ArrowRight'), trainingResetCar: key('ArrowDown'), trainingBoost: key('ArrowUp') };
  // Boost on F and ball cam on T (the new reset car / unlimited boost keys), PgDn on the scoreboard.
  const s = mergeSettings({ bindings: { kbm: { ...oldKbm, boost: key('KeyF'), ballCam: key('KeyT'), scoreboard: key('PageDown') } } });
  const k = s.bindings.kbm;
  assert.deepEqual(k.boost, key('KeyF'), 'boost stays on F');
  assert.deepEqual(k.ballCam, key('KeyT'));
  assert.deepEqual(k.scoreboard, key('PageDown'));
  assert.deepEqual(k.trainingResetCar, key('ArrowDown'), 'F taken: reset car keeps its arrow');
  assert.deepEqual(k.trainingBoost, key('ArrowUp'), 'T taken');
  assert.deepEqual(k.trainingNext, key('ArrowRight'), 'PgDn taken');
  assert.deepEqual(k.trainingPrev, DEFAULT_KBM.trainingPrev, 'PgUp free: moved');
  for (const code of ['KeyF', 'KeyT', 'PageDown']) {
    const users = ACTION_IDS.filter((a) => bindingsEqual(k[a], key(code)));
    assert.equal(users.length, 1, `${code} has one action: ${users.join(', ')}`);
  }
});
