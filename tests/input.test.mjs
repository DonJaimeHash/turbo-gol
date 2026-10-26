// Input layer tests (node --test tests/input.test.mjs). No DOM: the event target, document and
// gamepad are fakes; events are plain Event objects augmented with code / button / movementX.
import { test, mock } from 'node:test';
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
const { defaultSettings } = await import('../src/settings.ts');
const { GP, DEFAULT_KBM, KEYBOARD_ONLY_KBM, DEFAULT_PAD, ACTION_IDS, bindingsEqual } = await import('../src/input/bindings.ts');
const { emptyControls, TICK_RATE } = await import('../src/sim/types.ts');

// ---- Fakes ---------------------------------------------------------------------------------

class FakeTarget extends EventTarget {
  key(code, extra = {}) {
    this.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { code, ...extra }));
  }
  keyUp(code) {
    this.dispatchEvent(Object.assign(new Event('keyup'), { code }));
  }
  tap(code) {
    this.key(code);
    this.keyUp(code);
  }
  mouseDown(button) {
    this.dispatchEvent(Object.assign(new Event('mousedown', { cancelable: true }), { button }));
  }
  mouseUp(button) {
    this.dispatchEvent(Object.assign(new Event('mouseup', { cancelable: true }), { button }));
  }
  move(dx, dy) {
    this.dispatchEvent(Object.assign(new Event('mousemove'), { movementX: dx, movementY: dy }));
  }
  wheel(deltaY) {
    this.dispatchEvent(Object.assign(new Event('wheel', { cancelable: true }), { deltaY }));
  }
  blur() {
    this.dispatchEvent(new Event('blur'));
  }
}

class FakeDocument extends EventTarget {
  constructor() {
    super();
    this.pointerLockElement = null;
    this.visibilityState = 'visible';
  }
  exitPointerLock() {
    if (this.pointerLockElement === null) return;
    this.pointerLockElement = null;
    this.dispatchEvent(new Event('pointerlockchange'));
  }
}

function makeCanvas(doc) {
  return {
    requestPointerLock(opts) {
      this.lastOptions = opts;
      doc.pointerLockElement = this;
      doc.dispatchEvent(new Event('pointerlockchange'));
      return Promise.resolve();
    },
  };
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

function press(pad, i, value = 1) {
  pad.buttons[i].pressed = value > 0.5;
  pad.buttons[i].value = value;
}
function release(pad, i) {
  pad.buttons[i].pressed = false;
  pad.buttons[i].value = 0;
}

let padList = [];
navigator.getGamepads = () => padList;

function setup({ pad = null, settings = defaultSettings() } = {}) {
  padList = pad ? [pad] : [];
  const target = new FakeTarget();
  const doc = new FakeDocument();
  const changes = { count: 0 };
  const input = new Input(target, settings, { onChange: () => changes.count++, document: doc });
  const out = emptyControls();
  const sample = () => {
    input.sample(out);
    return out;
  };
  const lock = (button) => {
    const canvas = makeCanvas(doc);
    input.requestPointerLock(canvas, button);
    return canvas;
  };
  return { input, target, doc, settings, out, sample, lock, changes };
}

/** A capture arms on the macrotask after startRebind (the press that started it never ends it). */
const armed = () => new Promise((resolve) => setTimeout(resolve, 0));

function assertNoNaN(out, input) {
  for (const k of ['throttle', 'steer', 'pitch', 'yaw', 'roll']) {
    assert.ok(Number.isFinite(out[k]), `${k} = ${out[k]}`);
  }
  assert.ok(Number.isFinite(input.look.x) && Number.isFinite(input.look.y), 'look finite');
}

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

// ---- Keyboard + mouse (defaults) --------------------------------------------------------

test('KBM defaults: W/S throttle + air pitch (W nose down), A/D steer + yaw', () => {
  const { target, sample, input } = setup();
  target.key('KeyW');
  let o = sample();
  assert.equal(o.throttle, 1);
  assert.equal(o.pitch, -1);
  assert.equal(o.steer, 0);
  target.keyUp('KeyW');
  target.key('KeyS');
  o = sample();
  assert.equal(o.throttle, -1);
  assert.equal(o.pitch, 1);
  target.keyUp('KeyS');
  target.key('KeyA');
  o = sample();
  assert.equal(o.steer, -1);
  assert.equal(o.yaw, -1);
  assert.equal(o.roll, 0);
  target.keyUp('KeyA');
  target.key('KeyD');
  o = sample();
  assert.equal(o.steer, 1);
  assert.equal(o.yaw, 1);
  assertNoNaN(o, input);
  // A + D cancel out.
  target.key('KeyA');
  o = sample();
  assert.equal(o.steer, 0);
  assert.equal(o.yaw, 0);
});

test('KBM defaults: RMB jump, LMB boost, Left Shift powerslide + air roll, Q/E roll', () => {
  const { target, sample } = setup();
  target.mouseDown(2);
  let o = sample();
  assert.equal(o.jump, true);
  assert.equal(o.boost, false);
  target.mouseUp(2);
  target.mouseDown(0);
  o = sample();
  assert.equal(o.jump, false);
  assert.equal(o.boost, true);
  target.mouseUp(0);
  o = sample();
  assert.equal(o.boost, false);

  target.key('ShiftLeft');
  o = sample();
  assert.equal(o.handbrake, true);
  assert.equal(o.roll, 0);
  target.key('KeyD');
  o = sample();
  assert.equal(o.steer, 1, 'ground steering unaffected by the air roll modifier');
  assert.equal(o.yaw, 0, 'air roll held: D rolls instead of yawing');
  assert.equal(o.roll, 1);
  target.keyUp('KeyD');
  target.key('KeyA');
  o = sample();
  assert.equal(o.roll, -1);
  target.keyUp('KeyA');
  target.keyUp('ShiftLeft');
  o = sample();
  assert.equal(o.handbrake, false);

  target.key('KeyQ');
  o = sample();
  assert.equal(o.roll, -1);
  assert.equal(o.yaw, 0);
  target.keyUp('KeyQ');
  target.key('KeyE');
  o = sample();
  assert.equal(o.roll, 1);
  target.key('KeyD');
  o = sample();
  assert.equal(o.yaw, 1, 'without the modifier D yaws');
  assert.equal(o.roll, 1, 'E still rolls');
});

test('KBM one-shots: Space ball cam edge, R reset, Esc pause + back; keyboard never sets padActions', () => {
  const { target, sample, input } = setup();
  target.key('Space');
  sample();
  assert.equal(input.actions.toggleBallCam, true);
  assert.equal(input.padActions.toggleBallCam, false);
  input.consumeActions();
  sample(); // still held: no second edge
  assert.equal(input.actions.toggleBallCam, false);
  target.keyUp('Space');
  sample();
  target.key('Space');
  sample();
  assert.equal(input.actions.toggleBallCam, true, 'edge again after release');
  input.consumeActions();

  target.tap('KeyR');
  sample();
  assert.equal(input.actions.reset, true);
  input.consumeActions();
  sample();
  assert.equal(input.actions.reset, false);

  target.tap('Escape');
  sample();
  assert.equal(input.actions.pause, true);
  assert.equal(input.actions.back, true);
  assert.equal(input.padActions.pause, false);
  input.consumeActions();

  target.tap('Enter');
  assert.equal(input.actions.accept, true);
  target.tap('Backspace');
  assert.equal(input.actions.back, true);
  target.tap('ArrowUp');
  assert.equal(input.actions.menuUp, true);
  target.tap('KeyS');
  assert.equal(input.actions.menuDown, true);
  assert.equal(input.padActions.accept, false);
  assert.equal(input.padActions.menuUp, false);
});

test('KBM held states: MMB rear view, Tab scoreboard (Tab default prevented)', () => {
  const { target, sample, input } = setup();
  target.mouseDown(1);
  sample();
  assert.equal(input.held.rearView, true);
  assert.equal(input.look.rearView, true);
  target.mouseUp(1);
  sample();
  assert.equal(input.held.rearView, false);
  assert.equal(input.look.rearView, false);

  const ev = Object.assign(new Event('keydown', { cancelable: true }), { code: 'Tab' });
  target.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true);
  sample();
  assert.equal(input.held.scoreboard, true);
  sample();
  assert.equal(input.held.scoreboard, true, 'held, not an edge');
  target.keyUp('Tab');
  sample();
  assert.equal(input.held.scoreboard, false);
});

test('a key tap shorter than one tick still drives for one sample; repeats are ignored', () => {
  const { target, sample } = setup();
  target.tap('KeyW');
  assert.equal(sample().throttle, 1);
  assert.equal(sample().throttle, 0);
  target.key('KeyW', { repeat: true });
  assert.equal(sample().throttle, 0, 'auto-repeat keydown is not a press');
  target.mouseDown(2);
  target.mouseUp(2);
  assert.equal(sample().jump, true);
  assert.equal(sample().jump, false);
});

test('keyboard focus loss (blur) releases every held key and mouse button', () => {
  const { target, sample } = setup();
  target.key('KeyW');
  target.mouseDown(0);
  let o = sample();
  assert.equal(o.throttle, 1);
  assert.equal(o.boost, true);
  target.blur();
  o = sample();
  assert.equal(o.throttle, 0);
  assert.equal(o.boost, false);
});

test('keys typed into a text field are ignored', () => {
  const { target, sample } = setup();
  const field = new EventTarget();
  field.tagName = 'INPUT';
  const ev = Object.assign(new Event('keydown', { bubbles: true }), { code: 'KeyW' });
  Object.defineProperty(ev, 'target', { value: field });
  target.dispatchEvent(ev);
  assert.equal(sample().throttle, 0);
});

// ---- Mouse camera / pointer lock ------------------------------------------------------------

test('pointer lock: request uses unadjustedMovement, toggles pointerLocked and fires the callback', () => {
  const { input, lock, doc } = setup();
  const seen = [];
  input.onPointerLockChange = (l) => seen.push(l);
  assert.equal(input.pointerLocked, false);
  const canvas = lock();
  assert.deepEqual(canvas.lastOptions, { unadjustedMovement: true });
  assert.equal(input.pointerLocked, true);
  assert.equal(doc.pointerLockElement, canvas);
  input.exitPointerLock();
  assert.equal(input.pointerLocked, false);
  assert.deepEqual(seen, [true, false]);
});

test('mouse movement is ignored while the pointer is not locked', () => {
  const { target, sample, input } = setup();
  target.move(300, 0);
  sample();
  assert.equal(input.look.x, 0);
});

test('mouse swivel: a 300 px swipe at sensitivity 5 gives full deflection; decays to 0 within 1 s', () => {
  const { target, sample, input, lock } = setup();
  lock();
  target.move(150, 0);
  sample();
  near(input.look.x, 0.5);
  target.move(150, 0);
  sample();
  near(input.look.x, 1);
  target.move(300, 0);
  sample();
  near(input.look.x, 1, 1e-9); // clamped
  assert.equal(input.look.y, 0);
  // Keeps its value for a couple of ticks (mouse report gaps), then decays.
  sample();
  near(input.look.x, 1, 1e-9);
  let ticks = 0;
  while (input.look.x > 0 && ticks < TICK_RATE) {
    sample();
    ticks++;
  }
  assert.equal(input.look.x, 0, `still ${input.look.x} after ${ticks} ticks`);
  assert.ok(ticks < TICK_RATE, `decayed after ${ticks} ticks`);
  assert.ok(ticks > 20, `decay should not be instant (${ticks} ticks)`);

  // Vertical: mouse pulled back (+y) = look.y positive; length clamped to 1 diagonally.
  target.move(0, 150);
  sample();
  near(input.look.y, 0.5);
  target.move(300, 300);
  sample();
  near(Math.hypot(input.look.x, input.look.y), 1);
  assertNoNaN(sample(), input);
});

test('mouse sensitivity scales the swivel (sensitivity 10 = 150 px for full deflection)', () => {
  const { target, sample, input, lock, settings } = setup();
  settings.controls.mouseSensitivity = 10;
  input.settingsChanged();
  lock();
  target.move(75, 0);
  sample();
  near(input.look.x, 0.5);
});

test('losing pointer lock drops accumulated movement and the stick springs back', () => {
  const { target, sample, input, lock } = setup();
  lock();
  target.move(300, 0);
  sample();
  near(input.look.x, 1);
  target.move(300, 0);
  input.exitPointerLock();
  target.move(300, 0);
  for (let i = 0; i < TICK_RATE; i++) sample();
  assert.equal(input.look.x, 0);
});

test('mouse steering: mouse X steers / yaws, mouse Y pitches, look stays 0, decays quickly', () => {
  const { target, sample, input, lock, settings } = setup();
  settings.controls.mouseSteering = true;
  input.settingsChanged();
  lock();
  target.move(300, 0);
  let o = sample();
  near(o.steer, 1);
  near(o.yaw, 1);
  assert.equal(input.look.x, 0);
  assert.equal(input.look.y, 0);
  target.move(0, 300);
  o = sample();
  near(o.pitch, 1, 1e-9);
  target.move(0, -600);
  o = sample();
  near(o.pitch, -1, 1e-9);
  target.key('ShiftLeft');
  o = sample();
  assert.equal(o.yaw, 0);
  near(o.roll, 1, 1e-9); // mouse X rolls with the air-roll modifier
  target.keyUp('ShiftLeft');
  let ticks = 0;
  while (Math.abs(sample().steer) > 0 && ticks < TICK_RATE) ticks++;
  assert.ok(ticks < TICK_RATE / 3, `mouse steering recentres within ~0.3 s (${ticks} ticks)`);
  assert.equal(sample().steer, 0);
  // Sensitivity: 10 → 150 px for full lock.
  settings.controls.mouseSteeringSensitivity = 10;
  input.settingsChanged();
  target.move(-75, 0);
  o = sample();
  near(o.steer, -0.5);
  assertNoNaN(o, input);
});

test('mouse wheel is a one-sample tap usable as a binding', () => {
  const { target, sample, input } = setup();
  input.setBinding('ballCam', 'kbm', { kind: 'wheel', sign: -1 });
  target.wheel(-100);
  sample();
  assert.equal(input.actions.toggleBallCam, true);
  input.consumeActions();
  sample();
  assert.equal(input.actions.toggleBallCam, false);
  target.wheel(100);
  sample();
  assert.equal(input.actions.toggleBallCam, false, 'other direction does nothing');
});

// ---- Gamepad (defaults) ----------------------------------------------------------------

test('pad defaults: RT/LT analog throttle, LX steer with rescaled radial deadzone, LY pitch', () => {
  const pad = makePad();
  const { sample, input } = setup({ pad });
  assert.equal(input.hasGamepad, false);
  press(pad, GP.RT, 0.7);
  let o = sample();
  assert.equal(input.hasGamepad, true);
  assert.equal(input.gamepadName, pad.id);
  near(o.throttle, 0.7);
  press(pad, GP.LT, 1);
  o = sample();
  near(o.throttle, -0.3);
  release(pad, GP.RT);
  release(pad, GP.LT);

  pad.axes[GP.AXIS_LX] = 0.05; // inside the 0.1 deadzone
  o = sample();
  assert.equal(o.steer, 0);
  pad.axes[GP.AXIS_LX] = 0.55; // (0.55 - 0.1) / 0.9 = 0.5
  o = sample();
  near(o.steer, 0.5);
  near(o.yaw, 0.5);
  pad.axes[GP.AXIS_LX] = -1;
  o = sample();
  near(o.steer, -1);
  pad.axes[GP.AXIS_LX] = 0;
  pad.axes[GP.AXIS_LY] = -1; // stick forward
  o = sample();
  near(o.pitch, -1);
  assert.equal(o.throttle, 0, 'the left stick does not throttle');
  pad.axes[GP.AXIS_LY] = 1;
  o = sample();
  near(o.pitch, 1);
  // Radial: a diagonal at full deflection is normalised to unit length.
  pad.axes[GP.AXIS_LX] = 1;
  pad.axes[GP.AXIS_LY] = 1;
  o = sample();
  near(Math.hypot(o.steer, o.pitch), 1);
  assertNoNaN(o, input);
});

test('pad defaults: A jump, B boost, X powerslide + air roll with LX rolling, air roll L/R unbound', () => {
  const pad = makePad();
  const { sample } = setup({ pad });
  press(pad, GP.A);
  let o = sample();
  assert.equal(o.jump, true);
  release(pad, GP.A);
  press(pad, GP.B);
  o = sample();
  assert.equal(o.jump, false);
  assert.equal(o.boost, true);
  release(pad, GP.B);
  press(pad, GP.X);
  pad.axes[GP.AXIS_LX] = 1;
  o = sample();
  assert.equal(o.handbrake, true);
  assert.equal(o.yaw, 0);
  near(o.roll, 1);
  near(o.steer, 1);
  release(pad, GP.X);
  o = sample();
  assert.equal(o.handbrake, false);
  near(o.yaw, 1);
  assert.equal(o.roll, 0);
  pad.axes[GP.AXIS_LX] = 0;
  press(pad, GP.LB);
  press(pad, GP.RB);
  o = sample();
  assert.equal(o.roll, 0, 'bumpers are unbound by default');
});

test('pad defaults: Y ball cam edge (mirrored to padActions), RS click rear view, Back scoreboard, Start pause', () => {
  const pad = makePad();
  const { sample, input } = setup({ pad });
  press(pad, GP.Y);
  sample();
  assert.equal(input.actions.toggleBallCam, true);
  assert.equal(input.padActions.toggleBallCam, true);
  input.consumeActions();
  sample();
  assert.equal(input.padActions.toggleBallCam, false, 'held: no repeat');
  release(pad, GP.Y);

  press(pad, GP.RS);
  sample();
  assert.equal(input.held.rearView, true);
  assert.equal(input.look.rearView, true);
  release(pad, GP.RS);
  press(pad, GP.BACK);
  sample();
  assert.equal(input.held.rearView, false);
  assert.equal(input.held.scoreboard, true);
  assert.equal(input.actions.reset, false, 'Back is the scoreboard, not reset');
  release(pad, GP.BACK);

  press(pad, GP.START);
  sample();
  assert.equal(input.actions.pause, true);
  assert.equal(input.padActions.pause, true);
  input.consumeActions();
  sample();
  assert.equal(input.padActions.pause, false);
});

test('pad menu navigation: A accept, B back, D-pad and left stick edges (all mirrored)', () => {
  const pad = makePad();
  const { sample, input } = setup({ pad });
  press(pad, GP.A);
  sample();
  assert.equal(input.actions.accept, true);
  assert.equal(input.padActions.accept, true);
  release(pad, GP.A);
  input.consumeActions();
  press(pad, GP.B);
  sample();
  assert.equal(input.padActions.back, true);
  release(pad, GP.B);
  input.consumeActions();
  press(pad, GP.DPAD_DOWN);
  sample();
  assert.equal(input.padActions.menuDown, true);
  release(pad, GP.DPAD_DOWN);
  input.consumeActions();
  pad.axes[GP.AXIS_LY] = -0.9;
  sample();
  assert.equal(input.padActions.menuUp, true);
  input.consumeActions();
  sample();
  assert.equal(input.padActions.menuUp, false, 'edge only');
  pad.axes[GP.AXIS_LY] = 0;
  pad.axes[GP.AXIS_LX] = 0.9;
  sample();
  assert.equal(input.padActions.menuRight, true);
});

test('pad camera: RX / RY drive look (y = +1 when pulled back) with the deadzone', () => {
  const pad = makePad();
  const { sample, input } = setup({ pad });
  pad.axes[GP.AXIS_RX] = 1;
  sample();
  near(input.look.x, 1);
  assert.equal(input.look.y, 0);
  pad.axes[GP.AXIS_RX] = 0;
  pad.axes[GP.AXIS_RY] = 1;
  sample();
  near(input.look.y, 1);
  pad.axes[GP.AXIS_RY] = -0.55;
  sample();
  near(input.look.y, -0.5);
  pad.axes[GP.AXIS_RY] = 0.05;
  sample();
  assert.equal(input.look.y, 0);
});

test('steering / aerial sensitivity scale only the gamepad axes; invertAirPitch flips pitch', () => {
  const pad = makePad();
  const { sample, input, settings, target } = setup({ pad });
  settings.controls.steeringSensitivity = 2;
  settings.controls.aerialSensitivity = 3;
  input.settingsChanged();
  pad.axes[GP.AXIS_LX] = 0.28; // (0.28 - 0.1) / 0.9 = 0.2
  let o = sample();
  near(o.steer, 0.4);
  near(o.yaw, 0.6);
  pad.axes[GP.AXIS_LX] = 1;
  o = sample();
  near(o.steer, 1, 1e-9); // clamped
  pad.axes[GP.AXIS_LX] = 0;
  target.key('KeyD');
  o = sample();
  assert.equal(o.steer, 1, 'keyboard stays digital');
  target.keyUp('KeyD');
  settings.controls.invertAirPitch = true;
  input.settingsChanged();
  pad.axes[GP.AXIS_LY] = -1;
  o = sample();
  near(o.pitch, 1);
  target.key('KeyW');
  o = sample();
  near(o.pitch, 1, 1e-9); // -1 (W) -1 (stick) inverted and clamped
});

test('keyboard and gamepad sum and clamp, booleans OR', () => {
  const pad = makePad();
  const { sample, target } = setup({ pad });
  target.key('KeyW');
  press(pad, GP.LT, 0.4);
  let o = sample();
  near(o.throttle, 0.6);
  press(pad, GP.RT, 1);
  o = sample();
  near(o.throttle, 1);
  target.key('KeyD');
  pad.axes[GP.AXIS_LX] = -0.55;
  o = sample();
  near(o.steer, 0.5);
  press(pad, GP.A);
  o = sample();
  assert.equal(o.jump, true);
});

test('blockJumpUntilRelease swallows the held jump until it is released', () => {
  const pad = makePad();
  const { sample, input } = setup({ pad });
  press(pad, GP.A);
  assert.equal(sample().jump, true);
  input.blockJumpUntilRelease();
  assert.equal(sample().jump, false);
  assert.equal(sample().jump, false);
  release(pad, GP.A);
  assert.equal(sample().jump, false);
  press(pad, GP.A);
  assert.equal(sample().jump, true);
});

test('rumble respects settings.controls.vibration', () => {
  const pad = makePad();
  const calls = [];
  pad.vibrationActuator = { playEffect: (type, p) => (calls.push([type, p]), Promise.resolve()) };
  const { input, settings } = setup({ pad });
  input.rumble(0.5, 2, 100);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].weakMagnitude, 1);
  settings.controls.vibration = false;
  input.rumble(1, 1, 100);
  assert.equal(calls.length, 1);
});

// ---- Rebinding ------------------------------------------------------------------------------

test('startRebind captures the next key, applies it and the new binding drives the action', async () => {
  const { input, target, sample, changes } = setup();
  target.key('KeyW');
  assert.equal(sample().throttle, 1);
  const p = input.startRebind('jump', 'kbm');
  await armed();
  assert.equal(input.rebinding, true);
  assert.deepEqual(input.rebindTarget, { action: 'jump', device: 'kbm' });
  assert.equal(sample().throttle, 0, 'driving input is ignored while capturing');
  target.key('KeyW', { repeat: true });
  assert.equal(input.rebinding, true, 'a key held before the capture (and its auto-repeat) is not taken');
  target.keyUp('KeyW');
  target.key('KeyJ');
  const b = await p;
  assert.deepEqual(b, { kind: 'key', code: 'KeyJ' });
  assert.equal(input.rebinding, false);
  assert.deepEqual(input.getBinding('jump', 'kbm'), { kind: 'key', code: 'KeyJ' });
  assert.equal(input.getLabel('jump', 'kbm'), 'J');
  assert.ok(changes.count >= 1, 'onChange called');
  target.keyUp('KeyJ');
  assert.equal(sample().jump, false, 'the captured press itself does not jump');
  target.key('KeyJ');
  assert.equal(sample().jump, true);
  target.keyUp('KeyJ');
  target.mouseDown(2);
  assert.equal(sample().jump, false, 'RMB no longer jumps');
});

test('startRebind: Escape cancels and leaves the binding; a new capture cancels the previous one', async () => {
  const { input, target, changes } = setup();
  const before = changes.count;
  const p = input.startRebind('boost', 'kbm');
  target.key('Escape');
  assert.equal(await p, null);
  assert.deepEqual(input.getBinding('boost', 'kbm'), DEFAULT_KBM.boost);
  assert.equal(changes.count, before);
  const p1 = input.startRebind('boost', 'kbm');
  const p2 = input.startRebind('jump', 'kbm');
  assert.equal(await p1, null);
  input.cancelRebind();
  assert.equal(await p2, null);
});

test('startRebind times out after 10 s with null', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { input } = setup();
    const p = input.startRebind('reset', 'kbm');
    mock.timers.tick(9_999);
    assert.equal(input.rebinding, true);
    mock.timers.tick(1);
    assert.equal(await p, null);
    assert.equal(input.rebinding, false);
  } finally {
    mock.timers.reset();
  }
});

test('startRebind captures mouse buttons (including LMB) and wheel directions', async () => {
  const { input, target, sample } = setup();
  let p = input.startRebind('boost', 'kbm');
  await armed();
  target.mouseDown(0);
  assert.deepEqual(await p, { kind: 'mouse', button: 0 });
  target.mouseUp(0);
  p = input.startRebind('jump', 'kbm');
  await armed();
  target.mouseDown(4);
  assert.deepEqual(await p, { kind: 'mouse', button: 4 });
  target.mouseUp(4);
  target.mouseDown(4);
  assert.equal(sample().jump, true);
  target.mouseUp(4);
  p = input.startRebind('ballCam', 'kbm');
  await armed();
  target.wheel(120);
  assert.deepEqual(await p, { kind: 'wheel', sign: 1 });
  // A mouse button already held when the capture starts is ignored until released.
  target.mouseDown(2);
  p = input.startRebind('reset', 'kbm');
  await armed();
  target.mouseDown(2);
  target.mouseUp(2);
  target.mouseDown(2);
  assert.deepEqual(await p, { kind: 'mouse', button: 2 });
});

test('a wheel turn binds only over the capture target when one is given (scrolling the list does not)', async () => {
  const { input, target } = setup();
  const elsewhere = { contains: () => false };
  let p = input.startRebind('ballCam', 'kbm', elsewhere);
  await armed();
  target.wheel(120);
  assert.equal(input.rebinding, true, 'a wheel elsewhere is ignored');
  input.cancelRebind();
  assert.equal(await p, null);
  assert.deepEqual(input.getBinding('ballCam', 'kbm'), DEFAULT_KBM.ballCam);
  p = input.startRebind('ballCam', 'kbm', target); // the wheel event's target IS `target`
  await armed();
  target.wheel(-120);
  assert.deepEqual(await p, { kind: 'wheel', sign: -1 });
});

test('a capture arms on the next macrotask: the press whose handler started it is never the binding', async () => {
  const pad = makePad();
  const { input, target, sample } = setup({ pad });
  sample();
  // As if the Hud's keydown listener ran BEFORE Input's for the Enter that opened the capture.
  let p = input.startRebind('jump', 'kbm');
  target.key('Enter');
  target.keyUp('Enter');
  assert.equal(input.rebinding, true, 'same-dispatch key ignored');
  target.mouseDown(0);
  target.mouseUp(0);
  assert.equal(input.rebinding, true, 'same-dispatch mouse button ignored');
  await armed();
  target.key('KeyJ');
  assert.deepEqual(await p, { kind: 'key', code: 'KeyJ' });
  target.keyUp('KeyJ');
  // Pad: the A that accepted the row (edge seen by the same sample that started the capture).
  p = input.startRebind('boost', 'pad');
  press(pad, GP.A);
  sample();
  assert.equal(input.rebinding, true, 'pad press before arming ignored');
  release(pad, GP.A);
  await armed();
  sample();
  press(pad, GP.A);
  sample();
  assert.deepEqual(await p, { kind: 'gpButton', index: GP.A });
});

test('startRebind captures gamepad button edges and axis crossings with their sign', async () => {
  const pad = makePad();
  const { input, sample, target } = setup({ pad });
  press(pad, GP.LB);
  sample();
  let p = input.startRebind('airRollLeft', 'pad');
  await armed();
  sample();
  assert.equal(input.rebinding, true, 'a button held before the capture is not taken');
  target.key('KeyW');
  sample();
  assert.equal(input.rebinding, true, 'keyboard presses do not satisfy a pad capture');
  target.keyUp('KeyW');
  release(pad, GP.LB);
  sample();
  press(pad, GP.LB);
  sample();
  assert.deepEqual(await p, { kind: 'gpButton', index: GP.LB });
  assert.equal(sample().roll, -1, 'LB now rolls left');
  release(pad, GP.LB);

  p = input.startRebind('throttle', 'pad');
  await armed();
  pad.axes[GP.AXIS_LY] = -0.5;
  sample();
  assert.equal(input.rebinding, true, 'below the 0.6 threshold');
  pad.axes[GP.AXIS_LY] = -0.8;
  sample();
  assert.deepEqual(await p, { kind: 'gpAxis', index: GP.AXIS_LY, sign: -1 });
  pad.axes[GP.AXIS_LY] = -1;
  const o = sample();
  near(o.throttle, 1, 1e-9);
  pad.axes[GP.AXIS_LY] = 1;
  assert.equal(sample().throttle, 0);
});

test('setBinding allows shared keys and ignores bindings of the wrong device', () => {
  const { input, target, sample, changes } = setup();
  const before = changes.count;
  input.setBinding('boost', 'kbm', { kind: 'key', code: 'ShiftLeft' });
  assert.equal(changes.count, before + 1);
  assert.deepEqual(input.getBinding('powerslide', 'kbm'), { kind: 'key', code: 'ShiftLeft' }, 'powerslide untouched');
  target.key('ShiftLeft');
  const o = sample();
  assert.equal(o.boost, true);
  assert.equal(o.handbrake, true);
  input.setBinding('boost', 'kbm', { kind: 'gpButton', index: 1 });
  assert.deepEqual(input.getBinding('boost', 'kbm'), { kind: 'key', code: 'ShiftLeft' });
  input.setBinding('boost', 'kbm', null);
  assert.equal(input.getBinding('boost', 'kbm'), null);
  assert.equal(input.getLabel('boost', 'kbm'), '—');
  assert.equal(sample().boost, false);
});

test('keyboard-only preset: Space jump, L Shift boost, Z powerslide / air roll, C ball cam; reset restores the defaults', () => {
  const { input, target, sample, changes } = setup();
  input.resetBindings('kbm', 'keyboardOnly');
  for (const a of ACTION_IDS) assert.ok(bindingsEqual(input.getBinding(a, 'kbm'), KEYBOARD_ONLY_KBM[a]), a);
  // No preset binds a browser modifier (Ctrl + W closes the tab, Alt opens menus).
  for (const profile of [KEYBOARD_ONLY_KBM, DEFAULT_KBM]) {
    for (const a of ACTION_IDS) {
      const b = profile[a];
      if (b !== null && b.kind === 'key') assert.ok(!/^(Control|Alt|Meta|CapsLock)/.test(b.code), `${a}: ${b.code}`);
    }
  }
  target.key('Space');
  let o = sample();
  assert.equal(o.jump, true);
  assert.equal(input.actions.toggleBallCam, false);
  target.keyUp('Space');
  target.key('ShiftLeft');
  o = sample();
  assert.equal(o.boost, true);
  assert.equal(o.handbrake, false);
  target.keyUp('ShiftLeft');
  target.key('KeyZ');
  target.key('KeyD');
  o = sample();
  assert.equal(o.handbrake, true);
  assert.equal(o.roll, 1);
  assert.equal(o.yaw, 0);
  target.keyUp('KeyZ');
  target.keyUp('KeyD');
  target.tap('KeyC');
  sample();
  assert.equal(input.actions.toggleBallCam, true);
  input.consumeActions();
  const n = changes.count;
  input.applyPreset('kbm');
  assert.equal(changes.count, n + 1);
  for (const a of ACTION_IDS) assert.ok(bindingsEqual(input.getBinding(a, 'kbm'), DEFAULT_KBM[a]), a);
  input.resetBindings('pad', 'keyboardOnly');
  for (const a of ACTION_IDS) assert.ok(bindingsEqual(input.getBinding(a, 'pad'), DEFAULT_PAD[a]), a);
});

test('every change goes through onChange and mutates the settings object in place', () => {
  const { input, settings, changes } = setup();
  const kbm = settings.bindings.kbm;
  input.setBinding('reset', 'kbm', { kind: 'key', code: 'Backspace' });
  assert.equal(changes.count, 1);
  assert.equal(settings.bindings.kbm, kbm, 'profile object identity kept');
  assert.deepEqual(kbm.reset, { kind: 'key', code: 'Backspace' });
  input.resetBindings('kbm');
  assert.equal(changes.count, 2);
  assert.equal(settings.bindings.kbm, kbm);
  settings.controls.mouseSensitivity = 7;
  input.settingsChanged();
  assert.equal(changes.count, 3);
});

// ---- Robustness ---------------------------------------------------------------------------

test('no NaN ever: garbage axes, triggers, mouse deltas and settings', () => {
  const pad = makePad();
  const { input, sample, settings, target, lock } = setup({ pad });
  settings.controls.controllerDeadzone = 1;
  settings.controls.steeringSensitivity = NaN;
  settings.controls.aerialSensitivity = Infinity;
  settings.controls.mouseSensitivity = NaN;
  settings.controls.mouseSteeringSensitivity = -5;
  input.settingsChanged();
  pad.axes = [NaN, Infinity, -Infinity, 0.5, NaN];
  pad.buttons[GP.RT].value = NaN;
  pad.buttons[GP.RT].pressed = true;
  pad.buttons[GP.A].value = Infinity;
  lock();
  target.move(NaN, Infinity);
  target.move(1e9, -1e9);
  let o = sample();
  assertNoNaN(o, input);
  assert.ok(Math.abs(o.throttle) <= 1 && Math.abs(input.look.x) <= 1 && Math.abs(input.look.y) <= 1);
  settings.controls.mouseSteering = true;
  input.settingsChanged();
  target.move(NaN, 1e12);
  o = sample();
  assertNoNaN(o, input);
  pad.axes = [];
  pad.buttons = [];
  o = sample();
  assertNoNaN(o, input);
  // A profile with every binding removed still samples cleanly.
  for (const a of ACTION_IDS) {
    input.setBinding(a, 'kbm', null);
    input.setBinding(a, 'pad', null);
  }
  target.key('KeyW');
  o = sample();
  assertNoNaN(o, input);
  assert.equal(o.throttle, 0);
});

test('a non-standard pad is used as a fallback; losing the pad clears its state', () => {
  const pad = makePad();
  pad.mapping = '';
  const { sample, input } = setup({ pad });
  press(pad, GP.A);
  assert.equal(sample().jump, true);
  assert.equal(input.hasGamepad, true);
  padList = [];
  assert.equal(sample().jump, false);
  assert.equal(input.hasGamepad, false);
  assert.equal(input.gamepadName, null);
});

// ---- Menu hand-off, pointer-lock click, per-frame polling, look source ---------------------

test('latchEdges: a press made while the menu closed fires no one-shot edge on the first tick', () => {
  const { target, sample, input } = setup();
  sample(); // the menu frame's sample
  target.key('Space'); // closed the menu synchronously; still held when the first tick samples
  input.latchEdges();
  sample();
  assert.equal(input.actions.toggleBallCam, false, 'held through the latch: no edge');
  assert.equal(input.actions.accept, false, 'latch consumes the one-shots');
  target.keyUp('Space');
  sample();
  target.key('Space');
  sample();
  assert.equal(input.actions.toggleBallCam, true, 'a fresh press after the release toggles again');
  input.consumeActions();
  target.keyUp('Space');
  sample();
  // A tap that ended before the latch is swallowed too.
  target.tap('Space');
  input.latchEdges();
  sample();
  assert.equal(input.actions.toggleBallCam, false);
  // Same for the pad (ball cam rebound to A, the menu's accept button).
  const pad = makePad();
  const kit = setup({ pad });
  kit.input.setBinding('ballCam', 'pad', { kind: 'gpButton', index: GP.A });
  kit.sample();
  press(pad, GP.A);
  kit.sample(); // menu frame: A = accept → the match starts
  kit.input.latchEdges();
  kit.sample();
  assert.equal(kit.input.actions.toggleBallCam, false);
});

test('Escape cancels a controller capture too (and is not a menu back)', async () => {
  const pad = makePad();
  const { input, target, sample } = setup({ pad });
  sample();
  const p = input.startRebind('boost', 'pad');
  await armed();
  const ev = Object.assign(new Event('keydown', { cancelable: true }), { code: 'Escape' });
  target.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true);
  assert.equal(await p, null);
  assert.equal(input.rebinding, false);
  assert.equal(input.actions.back, false);
  assert.deepEqual(input.getBinding('boost', 'pad'), DEFAULT_PAD.boost);
  sample();
  assert.equal(input.actions.pause, false, 'the cancelling Escape never reaches the pause binding');
});

test('a pad detected during a capture with axes resting at -1 binds the pressed button, not an axis', async () => {
  const pad = makePad();
  pad.mapping = ''; // DirectInput-style: triggers are axes resting at -1
  pad.axes = [0, 0, -1, 0, 0, -1];
  const { input, sample } = setup(); // no pad yet (Chrome exposes one only after a button press)
  const p = input.startRebind('boost', 'pad');
  await armed();
  sample();
  assert.equal(input.rebinding, true);
  padList = [pad];
  press(pad, GP.B); // the press that wakes the pad is the one being bound
  sample();
  assert.deepEqual(await p, { kind: 'gpButton', index: GP.B });
  release(pad, GP.B);
  input.consumeActions();
  // The menu stick: a pad appearing with LY resting at -1 is not a "menu up" press either.
  padList = [];
  sample();
  assert.equal(input.hasGamepad, false);
  pad.axes = [0, -1, 0, 0];
  padList = [pad];
  sample();
  assert.equal(input.hasGamepad, true);
  assert.equal(input.padActions.menuUp, false, 'resting deflection is not an edge');
  pad.axes[GP.AXIS_LY] = 0;
  sample();
  pad.axes[GP.AXIS_LY] = -1;
  sample();
  assert.equal(input.padActions.menuUp, true, 'a real crossing still is');
});

test('beginFrame polls navigator.getGamepads once per frame; samples without it poll each time', () => {
  const pad = makePad();
  const { input, sample } = setup({ pad });
  const list = padList;
  let polls = 0;
  navigator.getGamepads = () => {
    polls++;
    return list;
  };
  try {
    sample();
    sample();
    assert.equal(polls, 2, 'no beginFrame: one poll per sample');
    input.beginFrame();
    assert.equal(polls, 3);
    sample();
    sample();
    sample();
    assert.equal(polls, 3, 'the frame snapshot is reused by every tick');
    press(pad, GP.A);
    assert.equal(sample().jump, true);
    input.beginFrame();
    assert.equal(polls, 4);
  } finally {
    navigator.getGamepads = () => padList;
  }
});

test('the click that requests the pointer lock is not a boost / jump until released', () => {
  const { input, target, sample, lock } = setup();
  lock(0); // the Game passes the button of the canvas click...
  target.mouseDown(0); // ...which then also reaches the window mousedown listener
  assert.equal(sample().boost, false);
  assert.equal(sample().boost, false, 'held: still masked');
  target.mouseUp(0);
  assert.equal(sample().boost, false, 'the release is not a tap');
  target.mouseDown(0);
  assert.equal(sample().boost, true, 'the next press boosts');
  target.mouseUp(0);
  // A right-click capture shorter than one tick does not jump either.
  input.exitPointerLock();
  lock(2);
  target.mouseDown(2);
  target.mouseUp(2);
  assert.equal(sample().jump, false);
  target.mouseDown(2);
  assert.equal(sample().jump, true);
  target.mouseUp(2);
  // Without a button nothing is masked (and garbage buttons are ignored).
  input.exitPointerLock();
  lock(undefined);
  target.mouseDown(0);
  assert.equal(sample().boost, true);
  target.mouseUp(0);
  input.exitPointerLock();
  lock(NaN);
  target.mouseDown(0);
  assert.equal(sample().boost, true);
});

test('lookSource names the device that moved the camera last; an idle pad never demotes the mouse', () => {
  const pad = makePad();
  const { input, target, sample, lock } = setup({ pad });
  sample();
  assert.equal(input.lookSource, 'none');
  lock();
  target.move(300, 0);
  sample();
  assert.equal(input.lookSource, 'mouse');
  for (let i = 0; i < TICK_RATE; i++) sample(); // the virtual stick decays to 0
  assert.equal(input.look.x, 0);
  assert.equal(input.lookSource, 'mouse', 'sticky while nothing else moves');
  pad.axes[GP.AXIS_RX] = 1;
  sample();
  assert.equal(input.lookSource, 'pad');
  pad.axes[GP.AXIS_RX] = 0;
  input.setBinding('lookLeft', 'kbm', { kind: 'key', code: 'ArrowLeft' });
  target.key('ArrowLeft');
  sample();
  assert.equal(input.lookSource, 'keys');
  target.keyUp('ArrowLeft');
  target.move(300, 0); // lookRight is still the mouse axis
  sample();
  assert.equal(input.lookSource, 'mouse');
});

test('dispose removes listeners, cancels a pending rebind and exits pointer lock', async () => {
  const { input, target, sample, lock } = setup();
  lock();
  assert.equal(input.pointerLocked, true);
  const p = input.startRebind('jump', 'kbm');
  input.dispose();
  assert.equal(await p, null);
  assert.equal(input.pointerLocked, false);
  target.key('KeyW');
  assert.equal(sample().throttle, 0);
  input.dispose(); // idempotent
});

// ---- UI at rest (Game.ts frame): the menus read the pad on every animation frame ----------------

const { runsLogic, drawsScene, sceneFps, TIERS } = await import('../src/render/quality.ts');

/**
 * Drive Input like Game.frame on a 60 Hz display for `presses` D-pad taps of `ms` each (start phases
 * spread over a frame), the menus up on super low: the logic runs when runsLogic says (`readEvery`
 * = true: today's loop; false: a loop that read the pad only on drawn frames), the scene is drawn
 * at sceneFps. Returns the menuDown edges seen and the drawn frames per second.
 */
function menuLoop(ms, presses, readEvery) {
  const pad = makePad();
  const { input, out } = setup({ pad });
  const fps = sceneFps({ cover: 'partial', cap: TIERS.superlow.maxFps, lite: true, still: false, animated: true, phone: false, covered: 0 });
  const frame = 1000 / 60;
  const gap = 300; // between taps
  const starts = Array.from({ length: presses }, (_, i) => 100 + i * gap + (i * 7.3) % frame);
  const end = 100 + presses * gap + 200;
  let lastLogic = -1;
  let lastDraw = -1;
  let edges = 0;
  let drawn = 0;
  for (let t = 0; t < end; t += frame) {
    const down = starts.some((s) => t >= s && t < s + ms);
    if (down) press(pad, GP.DPAD_DOWN);
    else release(pad, GP.DPAD_DOWN);
    const draw = drawsScene(t, lastDraw, fps, false);
    const logic = readEvery ? runsLogic(t, lastLogic, TIERS.superlow.maxFps, false) : draw;
    if (draw) {
      lastDraw = t;
      drawn++;
    }
    if (!logic) continue;
    lastLogic = t;
    input.beginFrame();
    input.sample(out);
    if (input.padActions.menuDown) edges++;
    input.consumeActions();
  }
  return { edges, fps: (drawn * 1000) / end };
}

test('menus at 20 fps (super low): every D-pad tap of 20-60 ms moves the focus once; drawn-frame reads lose some', () => {
  for (const ms of [20, 30, 40, 50, 60]) {
    const r = menuLoop(ms, 40, true);
    assert.equal(r.edges, 40, `${ms} ms taps: ${r.edges} of 40`);
    assert.ok(Math.abs(r.fps - 20) < 0.6, `the scene at ${r.fps} fps`);
  }
  // The same taps read only on the 20 fps drawn frames (the old loop's cadence, slower): lost ones.
  const old = menuLoop(30, 40, false);
  assert.ok(old.edges < 40, `drawn-frame reads saw ${old.edges} of 40`);
});
