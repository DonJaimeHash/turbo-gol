// Touch controls tests (node --test tests/touch.test.mjs). No DOM: TouchState is pure, and the
// Input integration uses the same fake event target / document / gamepad as tests/input.test.mjs.
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
const { TouchState, TB, TOUCH_BUTTON_COUNT, TOUCH_BUTTON_ACTIONS, TOUCH_STICK_ACTIONS, stickVector, hitCircle } =
  await import('../src/input/touchState.ts');
const { defaultSettings } = await import('../src/settings.ts');
const { GP, ACTION_IDS } = await import('../src/input/bindings.ts');
const { emptyControls } = await import('../src/sim/types.ts');

// ---- Fakes (as in tests/input.test.mjs) -------------------------------------------------

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
    requestPointerLock() {
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

function setup({ pad = null, settings = defaultSettings(), touch = true } = {}) {
  padList = pad ? [pad] : [];
  const target = new FakeTarget();
  const doc = new FakeDocument();
  const input = new Input(target, settings, { document: doc });
  const ts = new TouchState();
  if (touch) input.setTouchSource(ts);
  const out = emptyControls();
  const sample = () => {
    input.sample(out);
    return out;
  };
  const lock = (button) => input.requestPointerLock(makeCanvas(doc), button);
  return { input, target, doc, settings, out, sample, lock, ts };
}

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const N = ACTION_IDS.length;

/** The non-zero actions of one read(), by name. `out` starts as garbage: read must write every index. */
function readMap(ts) {
  const out = new Float64Array(N).fill(7);
  ts.read(out);
  const m = {};
  for (let i = 0; i < N; i++) if (out[i] !== 0) m[ACTION_IDS[i]] = out[i];
  return m;
}

// ---- stickVector / hitCircle ------------------------------------------------------------

const R = 80;
const DIRS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];
const DIAGONALS = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

test('stickVector: 0 inside the deadzone, continuous at its edge, up on screen = +y', () => {
  for (const [ux, uy] of [...DIRS, [Math.SQRT1_2, Math.SQRT1_2], [-0.6, 0.8]]) {
    for (const f of [0, 0.05, 0.1, 0.1199]) {
      const v = stickVector(ux * f * R, uy * f * R, R);
      assert.ok(Object.is(v.x, 0) && Object.is(v.y, 0), `inside the 0.12 deadzone at ${f}: ${v.x}, ${v.y}`);
    }
    const v = stickVector(ux * 0.1201 * R, uy * 0.1201 * R, R);
    assert.ok(Math.hypot(v.x, v.y) < 1e-3, 'just past the deadzone starts near 0 (rescaled, no jump)');
  }
  // Monotonic and continuous along a ray from the deadzone out to the radius.
  let prev = 0;
  for (let f = 0.12; f <= 1.0001; f += 0.01) {
    const m = stickVector(f * R, 0, R).x;
    assert.ok(m >= prev && m - prev < 0.02, `step at ${f.toFixed(2)}: ${prev} → ${m}`);
    prev = m;
  }
  assert.equal(stickVector(0, -R, R).y, 1, 'finger above the centre: +y');
  assert.equal(stickVector(0, R, R).y, -1);
  assert.equal(stickVector(R, 0, R).x, 1);
  assert.equal(stickVector(-R, 0, R).x, -1);
  assert.ok(Object.is(stickVector(R, 0, R).y, 0), 'a horizontal drag gives y = +0, never -0');
});

test('stickVector: magnitude 1 at the radius, ≥ 0.85 per axis at 45°, clamped to ±1', () => {
  for (const [ux, uy] of DIRS) {
    const v = stickVector(ux * R, uy * R, R);
    near(Math.hypot(v.x, v.y), 1);
  }
  for (const [sx, sy] of DIAGONALS) {
    const v = stickVector(sx * Math.SQRT1_2 * R, sy * Math.SQRT1_2 * R, R);
    assert.ok(Math.abs(v.x) >= 0.85 && Math.abs(v.y) >= 0.85, `45°: ${v.x}, ${v.y}`);
    assert.equal(Math.sign(v.x), sx);
    assert.equal(Math.sign(v.y), -sy, 'screen y down → stick y up');
    const far = stickVector(sx * 5 * R, sy * 5 * R, R);
    assert.ok(Math.abs(far.x) <= 1 && Math.abs(far.y) <= 1, 'clamped past the radius');
    near(far.x, v.x);
    near(far.y, v.y);
  }
  for (const [ux, uy] of DIRS) {
    const v = stickVector(ux * 3 * R, uy * 3 * R, R);
    assert.deepEqual([Math.abs(v.x), Math.abs(v.y)], [Math.abs(ux), Math.abs(uy)], 'clamped to ±1 on the axes');
  }
  // The gain saturates an axis before the rim: (0.824 - 0.12) / 0.88 × 1.25 = 1.
  assert.equal(stickVector(0.83 * R, 0, R).x, 1);
});

test('stickVector: same radial deadzone math as the gamepad stick (gain 1)', () => {
  const pad = makePad();
  const { sample } = setup({ pad, touch: false });
  const points = [
    [0.05, 0],
    [0.55, 0],
    [0.3, 0.4],
    [-0.7, 0.7],
    [1, 1],
    [0.08, -0.05],
    [0, -1],
    [-0.2, -0.9],
  ];
  for (const [ax, ay] of points) {
    pad.axes[GP.AXIS_LX] = ax;
    pad.axes[GP.AXIS_LY] = ay;
    const o = sample();
    const v = stickVector(ax * R, ay * R, R, 0.1, 1); // controllerDeadzone default 0.1
    near(v.x, o.steer, 1e-12);
    near(v.y, -o.pitch, 1e-12); // pad LY + = stick back = pitch up; screen dy + = down = stick y -
  }
});

test('stickVector: garbage gives 0, a huge finite offset is a full deflection; out is reused', () => {
  const garbage = [
    [NaN, 0, R],
    [10, NaN, R],
    [10, 10, 0],
    [10, 10, -5],
    [10, 10, NaN],
    [Infinity, 0, R],
  ];
  for (const args of garbage) {
    assert.deepEqual(stickVector(...args), { x: 0, y: 0 }, `stickVector(${args.join(', ')})`);
  }
  near(stickVector(0.5 * R, 0, R, NaN, NaN).x, 0.5, 1e-12); // bad deadzone / gain → 0 and 1
  // A huge but finite offset is a full deflection (the magnitude must not overflow to Infinity).
  assert.deepEqual(stickVector(1e200, 0, 1), { x: 1, y: 0 });
  const huge = stickVector(1e200, -1e200, 1);
  near(huge.x, Math.SQRT1_2 * 1.25, 1e-12);
  near(huge.y, huge.x, 1e-12);
  const o = { x: 9, y: 9 };
  assert.equal(stickVector(R, 0, R, 0.12, 1.25, o), o);
  assert.deepEqual(o, { x: 1, y: 0 });
});

test('hitCircle: inside and on the edge hit, outside and degenerate circles miss', () => {
  assert.equal(hitCircle(100, 100, 100, 100, 40), true);
  assert.equal(hitCircle(140, 100, 100, 100, 40), true, 'edge');
  assert.equal(hitCircle(129, 129, 100, 100, 40), false, 'corner of the bounding box');
  assert.equal(hitCircle(128, 128, 100, 100, 40), true);
  assert.equal(hitCircle(100, 100, 100, 100, 0), false);
  assert.equal(hitCircle(NaN, 100, 100, 100, 40), false);
});

// ---- TouchState ---------------------------------------------------------------------------

test('mapping table: stick → throttle / reverse, steer + yaw, pitch; buttons → their actions', () => {
  const ts = new TouchState();
  assert.deepEqual(readMap(ts), {}, 'idle: every action 0');
  ts.setStick(0, 1);
  assert.deepEqual(readMap(ts), { throttle: 1, pitchDown: 1 }, 'stick up = W');
  ts.setStick(0, -0.5);
  assert.deepEqual(readMap(ts), { reverse: 0.5, pitchUp: 0.5 }, 'stick down = S');
  ts.setStick(-0.75, 0);
  assert.deepEqual(readMap(ts), { steerLeft: 0.75, yawLeft: 0.75 });
  ts.setStick(0.6, -0.4);
  assert.deepEqual(readMap(ts), { steerRight: 0.6, yawRight: 0.6, reverse: 0.4, pitchUp: 0.4 });
  ts.setStick(3, NaN);
  assert.deepEqual([ts.stickX, ts.stickY], [1, 0], 'setStick clamps, NaN = 0');
  ts.setStick(0, 0);

  const expected = [
    [TB.JUMP, { jump: 1 }],
    [TB.BOOST, { boost: 1 }],
    [TB.DRIFT, { powerslide: 1, airRoll: 1 }],
    [TB.CAM, { ballCam: 1 }],
    [TB.PAUSE, { pause: 1 }],
    [TB.RESET, { trainingReset: 1 }],
  ];
  assert.equal(expected.length, TOUCH_BUTTON_COUNT);
  for (const [b, map] of expected) {
    ts.press(b);
    assert.deepEqual(readMap(ts), map, `button ${b}`);
    ts.release(b);
    assert.deepEqual(readMap(ts), {});
  }
  // Every mapped id is a real action, and touch never drives the camera look.
  for (const list of [...Object.values(TOUCH_STICK_ACTIONS), ...Object.values(TOUCH_BUTTON_ACTIONS)]) {
    for (const a of list) {
      assert.ok(ACTION_IDS.includes(a), a);
      assert.ok(!a.startsWith('look'), a);
    }
  }
});

test('a press + release before read counts once (latch); held counts every read; fingers are counted', () => {
  const ts = new TouchState();
  ts.press(TB.JUMP);
  ts.release(TB.JUMP);
  assert.deepEqual(readMap(ts), { jump: 1 }, 'tap shorter than one read');
  assert.deepEqual(readMap(ts), {}, 'then 0');

  ts.press(TB.BOOST);
  assert.equal(ts.isHeld(TB.BOOST), true);
  assert.deepEqual(readMap(ts), { boost: 1 });
  assert.deepEqual(readMap(ts), { boost: 1 }, 'still held');
  ts.press(TB.BOOST); // a second finger slides onto it
  ts.release(TB.BOOST);
  assert.equal(ts.isHeld(TB.BOOST), true, 'one finger still on it');
  assert.deepEqual(readMap(ts), { boost: 1 });
  ts.release(TB.BOOST);
  ts.release(TB.BOOST); // a stray release with no finger left: ignored, the count never goes negative
  assert.equal(ts.isHeld(TB.BOOST), false);
  assert.deepEqual(readMap(ts), {});
  ts.press(TB.BOOST);
  assert.equal(ts.isHeld(TB.BOOST), true);
  assert.deepEqual(readMap(ts), { boost: 1 });
  assert.deepEqual(readMap(ts), { boost: 1 }, 'the next press holds again (not a one-read tap)');
  ts.release(TB.BOOST);
  assert.deepEqual(readMap(ts), {});
  ts.press(TB.BOOST);
  ts.release(TB.BOOST);
  assert.deepEqual(readMap(ts), { boost: 1 }, 'a later tap still counts after the stray release');
  assert.deepEqual(readMap(ts), {});
});

test('releaseAll forgets the stick, held buttons and pending taps', () => {
  const ts = new TouchState();
  ts.setStick(0.5, 0.5);
  ts.press(TB.BOOST);
  ts.press(TB.BOOST);
  ts.press(TB.DRIFT);
  ts.press(TB.JUMP);
  ts.release(TB.JUMP); // pending tap
  ts.releaseAll();
  assert.deepEqual([ts.stickX, ts.stickY], [0, 0]);
  for (let b = 0; b < TOUCH_BUTTON_COUNT; b++) assert.equal(ts.isHeld(b), false);
  assert.deepEqual(readMap(ts), {});
  ts.release(TB.BOOST); // stray: no finger left after releaseAll
  ts.press(TB.BOOST);
  readMap(ts);
  assert.deepEqual(readMap(ts), { boost: 1 }, 'counters restart from 0: one press holds');
  ts.release(TB.BOOST);
  assert.deepEqual(readMap(ts), {});
});

// ---- Input integration ------------------------------------------------------------------

/** Every Input output after a sample, in a fixed order. */
function snapshot(kit) {
  const { out, input } = kit;
  return [
    ...Object.entries(out),
    ...Object.entries(input.actions).map(([k, v]) => ['a.' + k, v]),
    ...Object.entries(input.padActions).map(([k, v]) => ['pa.' + k, v]),
    ['held.scoreboard', input.held.scoreboard],
    ['held.rearView', input.held.rearView],
    ['look.x', input.look.x],
    ['look.y', input.look.y],
    ['look.rearView', input.look.rearView],
    ['lookSource', input.lookSource],
  ];
}

/** A scripted keyboard + mouse + pad session; returns the snapshot of every sample. */
function scriptedRun(mode, configure) {
  const pad = makePad();
  const settings = defaultSettings();
  configure(settings);
  const kit = setup({ pad, settings, touch: false });
  const { input, target } = kit;
  // Four warm-up samples. 'null': a source that drives everything for three of them, then
  // removed (its last values must not linger); 'idle': a source plugged in and never touched.
  const ts = new TouchState();
  if (mode === 'null') {
    ts.setStick(0.7, -0.7);
    for (let b = 0; b < TOUCH_BUTTON_COUNT; b++) ts.press(b);
  }
  if (mode !== 'never') input.setTouchSource(ts);
  for (let i = 0; i < 4; i++) {
    if (mode === 'null' && i === 3) input.setTouchSource(null);
    kit.sample();
    input.consumeActions();
  }
  const steps = [
    () => target.key('KeyW'),
    () => {
      target.key('KeyD');
      press(pad, GP.RT, 0.7);
    },
    () => {
      kit.lock(0);
      target.mouseDown(0); // the capturing click: masked
    },
    () => {
      target.mouseUp(0);
      target.move(120, -40);
    },
    () => target.mouseDown(0),
    () => {
      target.mouseDown(2);
      target.key('ShiftLeft');
      pad.axes[GP.AXIS_LX] = 0.6;
      pad.axes[GP.AXIS_LY] = -0.3;
    },
    () => {
      target.tap('Space');
      target.move(-7, 3);
    },
    () => press(pad, GP.Y),
    () => {
      target.keyUp('ShiftLeft');
      target.keyUp('KeyW');
      target.key('KeyS');
      press(pad, GP.LT, 0.35);
    },
    () => target.tap('Escape'),
    () => input.blockJumpUntilRelease(),
    () => {
      target.mouseUp(2);
      target.wheel(-100);
      press(pad, GP.A);
    },
    () => {
      press(pad, GP.START);
      target.key('KeyR');
      input.latchEdges();
    },
    () => {
      release(pad, GP.START);
      release(pad, GP.Y);
      press(pad, GP.X);
      pad.axes[GP.AXIS_RX] = -0.8;
      target.key('Tab');
      target.mouseDown(1);
    },
    () => {
      target.keyUp('KeyR');
      target.tap('KeyR');
      target.tap('Backspace');
      target.key('KeyQ');
      pad.axes[GP.AXIS_LX] = -1;
    },
    () => {
      target.keyUp('KeyD');
      target.keyUp('KeyS');
      target.keyUp('KeyQ');
      target.mouseUp(0);
      target.mouseUp(1);
      target.keyUp('Tab');
      for (const b of [GP.RT, GP.LT, GP.A, GP.X]) release(pad, b);
      pad.axes.fill(0);
    },
  ];
  const snaps = [];
  for (const step of steps) {
    step();
    kit.sample();
    snaps.push(snapshot(kit));
    input.consumeActions();
  }
  for (let i = 0; i < 40; i++) {
    kit.sample(); // the mouse sticks decay
    snaps.push(snapshot(kit));
    input.consumeActions();
  }
  return snaps;
}

/**
 * One sample of a run in the GOLDEN format: every output that is not at rest (0, false and 'none'
 * are left out; true is written as the bare name, -0 as -0, numbers in full precision).
 */
function goldenLine(snap) {
  const parts = [];
  for (const [k, v] of snap) {
    if (v === false || v === 'none' || Object.is(v, 0)) continue;
    parts.push(v === true ? k : `${k}=${Object.is(v, -0) ? '-0' : v}`);
  }
  return parts.join(' ');
}

/**
 * scriptedRun('never') of each variant, recorded with the Input.ts that predates touch support
 * (main at a3ce864, before setTouchSource existed), so the no-touch path is checked against the
 * old behaviour and not only against itself. If Input changes on purpose, re-record it from the
 * assertion diff (re-recorded once for the menu edges: RT is also menuTabNext, Y also menuCancel).
 */
const GOLDEN = {
  defaults: [
    'throttle=1 pitch=-1 a.menuUp',
    'throttle=1 steer=1 pitch=-1 yaw=1 a.menuRight a.menuTabNext pa.menuTabNext',
    'throttle=1 steer=1 pitch=-1 yaw=1',
    'throttle=1 steer=1 pitch=-1 yaw=1 look.x=0.4 look.y=-0.13333333333333333 lookSource=mouse',
    'throttle=1 steer=1 pitch=-1 yaw=1 boost look.x=0.4 look.y=-0.13333333333333333 lookSource=mouse',
    'throttle=1 steer=1 pitch=-1 roll=1 jump boost handbrake look.x=0.4 look.y=-0.13333333333333333 lookSource=mouse',
    'throttle=1 steer=1 pitch=-1 roll=1 jump boost handbrake a.toggleBallCam look.x=0.3766666666666667 look.y=-0.12333333333333334 lookSource=mouse',
    'throttle=1 steer=1 pitch=-1 roll=1 jump boost handbrake a.toggleBallCam a.menuCancel pa.toggleBallCam pa.menuCancel look.x=0.3766666666666667 look.y=-0.12333333333333334 lookSource=mouse',
    'throttle=-0.65 steer=1 pitch=0.716357066166662 yaw=1 jump boost a.menuDown look.x=0.3766666666666667 look.y=-0.12333333333333334 lookSource=mouse',
    'throttle=-0.65 steer=1 pitch=0.716357066166662 yaw=1 jump boost a.pause a.back look.x=0.3643180645148889 look.y=-0.11928998572611406 lookSource=mouse',
    'throttle=-0.65 steer=1 pitch=0.716357066166662 yaw=1 boost look.x=0.3523742976952427 look.y=-0.11537919482056619 lookSource=mouse',
    'throttle=-0.65 steer=1 pitch=0.716357066166662 yaw=1 boost a.accept pa.accept look.x=0.34082209412687814 look.y=-0.11159661489110168 lookSource=mouse',
    'throttle=-0.65 steer=1 pitch=0.716357066166662 yaw=1 boost look.x=0.318841449708798 look.y=-0.10439941273650906 lookSource=mouse',
    'throttle=-0.65 steer=1 pitch=0.716357066166662 roll=1 boost handbrake a.settings pa.settings held.scoreboard held.rearView look.x=-0.4693891941184046 look.y=-0.10097679287961775 look.rearView lookSource=pad',
    'throttle=-0.65 steer=0.04217371477884868 pitch=0.7126521144336546 roll=-0.9578262852211513 boost handbrake a.back a.menuLeft a.trainingReset pa.menuLeft held.scoreboard held.rearView look.x=-0.47949937445759 look.y=-0.09766637984820306 look.rearView lookSource=pad',
    'look.x=0.28849967411735106 look.y=-0.09446449506497333 lookSource=mouse',
    'look.x=0.27904152979011376 look.y=-0.09136758055074519 lookSource=mouse',
    'look.x=0.2698934603161273 look.y=-0.08837219497076733 lookSource=mouse',
    'look.x=0.2610453002325597 look.y=-0.08547500981066111 lookSource=mouse',
    'look.x=0.25248721734009083 look.y=-0.08267280567772883 lookSource=mouse',
    'look.x=0.24420970177723536 look.y=-0.07996246872351952 lookSource=mouse',
    'look.x=0.23620355545285118 look.y=-0.07734098718367691 lookSource=mouse',
    'look.x=0.22845988182509197 look.y=-0.07480544803122477 lookSource=mouse',
    'look.x=0.22097007601544535 look.y=-0.07235303373957057 lookSource=mouse',
    'look.x=0.21372581524687148 look.y=-0.06998101915163045 lookSource=mouse',
    'look.x=0.20671904959541668 look.y=-0.06768676845159657 lookSource=mouse',
    'look.x=0.1999419930450253 look.y=-0.0654677322359817 lookSource=mouse',
    'look.x=0.19338711483560972 look.y=-0.06332144468068633 lookSource=mouse',
    'look.x=0.1870471310947643 look.y=-0.061245520800940485 lookSource=mouse',
    'look.x=0.1809149967438245 look.y=-0.059237653801075235 lookSource=mouse',
    'look.x=0.17498389766927672 look.y=-0.05729561251117906 lookSource=mouse',
    'look.x=0.16924724315082018 look.y=-0.05541723890779064 lookSource=mouse',
    'look.x=0.1636986585376662 look.y=-0.05360044571587296 lookSource=mouse',
    'look.x=0.1583319781649369 look.y=-0.05184321408940409 lookSource=mouse',
    'look.x=0.1531412385022924 look.y=-0.05014359136800721 lookSource=mouse',
    'look.x=0.14812067152717207 look.y=-0.0484996889071271 lookSource=mouse',
    'look.x=0.14326469831528746 look.y=-0.046909679979341874 lookSource=mouse',
    'look.x=0.13856792284124334 look.y=-0.045371797744477874 lookSource=mouse',
    'look.x=0.13402512598239885 look.y=-0.043884333286272156 lookSource=mouse',
    'look.x=0.1296312597193054 look.y=-0.04244563371340085 lookSource=mouse',
    'look.x=0.1253814415262767 look.y=-0.04105410032276313 lookSource=mouse',
    'look.x=0.12127094894585799 look.y=-0.03970818682298002 lookSource=mouse',
    'look.x=0.11729521434116519 look.y=-0.0384063976161337 lookSource=mouse',
    'look.x=0.11344981982026285 look.y=-0.037147286135838245 lookSource=mouse',
    'look.x=0.10973049232694082 look.y=-0.03592945323979475 lookSource=mouse',
    'look.x=0.10613309889243437 look.y=-0.034751545655044846 lookSource=mouse',
    'look.x=0.10265364204281147 look.y=-0.03361225447419487 lookSource=mouse',
    'look.x=0.0992882553569238 look.y=-0.03251031370093962 lookSource=mouse',
    'look.x=0.09603319916998547 look.y=-0.031444498843269546 lookSource=mouse',
    'look.x=0.09288485641800515 look.y=-0.030413625552798116 lookSource=mouse',
    'look.x=0.08983972861845396 look.y=-0.029416548308697284 lookSource=mouse',
    'look.x=0.0868944319827027 look.y=-0.028452159144778732 lookSource=mouse',
    'look.x=0.08404569365590861 look.y=-0.02751938641830633 lookSource=mouse',
    'look.x=0.08129034808017319 look.y=-0.026617193619171725 lookSource=mouse',
    'look.x=0.07862533347693003 look.y=-0.025744578218109805 lookSource=mouse',
    'look.x=0.07604768844465358 look.y=-0.024900570552674153 lookSource=mouse',
  ],
  'mouse steering + inverted air pitch': [
    'throttle=1 pitch=1 a.menuUp',
    'throttle=1 steer=1 pitch=1 yaw=1 a.menuRight a.menuTabNext pa.menuTabNext',
    'throttle=1 steer=1 pitch=1 yaw=1',
    'throttle=1 steer=1 pitch=1 yaw=1',
    'throttle=1 steer=1 pitch=1 yaw=1 boost',
    'throttle=1 steer=1 pitch=1 roll=1 jump boost handbrake',
    'throttle=1 steer=1 pitch=1 roll=1 jump boost handbrake a.toggleBallCam',
    'throttle=1 steer=1 pitch=1 roll=1 jump boost handbrake a.toggleBallCam a.menuCancel pa.toggleBallCam pa.menuCancel',
    'throttle=-0.65 steer=1 pitch=-0.5930237328333287 yaw=1 jump boost a.menuDown',
    'throttle=-0.65 steer=1 pitch=-0.6090170166472104 yaw=1 jump boost a.pause a.back',
    'throttle=-0.65 steer=1 pitch=-0.6229363669977027 yaw=1 boost',
    'throttle=-0.65 steer=1 pitch=-0.6350507217752739 yaw=1 boost a.accept pa.accept',
    'throttle=-0.65 steer=1 pitch=-0.6547703455727512 yaw=1 boost',
    'throttle=-0.65 steer=1 pitch=-0.662756620450789 roll=1 boost handbrake a.settings pa.settings held.scoreboard held.rearView look.x=-0.7777777777777778 look.rearView lookSource=pad',
    'throttle=-0.65 steer=0.18464470488993687 pitch=-0.6660023212114399 roll=-0.8153552951100631 boost handbrake a.back a.menuLeft a.trainingReset pa.menuLeft held.scoreboard held.rearView look.x=-0.7777777777777778 look.rearView lookSource=pad',
    'steer=0.12399602540764453 pitch=0.04060046849630838 yaw=0.12399602540764453 lookSource=pad',
    'steer=0.10791680681733835 pitch=0.0353355916127568 yaw=0.10791680681733835 lookSource=pad',
    'steer=0.09392266530611498 pitch=0.03075343908253322 yaw=0.09392266530611498 lookSource=pad',
    'steer=0.08174321793208583 pitch=0.026765478437939604 yaw=0.08174321793208583 lookSource=pad',
    'steer=0.0711431437354817 pitch=0.023294657683299313 yaw=0.0711431437354817 lookSource=pad',
    'steer=0.06191763706650861 pitch=0.02027391656160016 yaw=0.06191763706650861 lookSource=pad',
    'steer=0.05388845050416049 pitch=0.017644890873043696 yaw=0.05388845050416049 lookSource=pad',
    'steer=0.046900450910619715 pitch=0.015356784811441851 yaw=0.046900450910619715 lookSource=pad',
    'steer=0.040818622080247495 pitch=0.013365389530700506 yaw=0.040818622080247495 lookSource=pad',
    'steer=0.03552545607088819 pitch=0.011632228978963387 yaw=0.03552545607088819 lookSource=pad',
    'steer=0.030918682815001923 pitch=0.01012381649694753 yaw=0.030918682815001923 lookSource=pad',
    'steer=0.026909294144096114 pitch=0.008811007817093416 yaw=0.026909294144096114 lookSource=pad',
    'steer=0.023419824048330512 pitch=0.007668437962727689 yaw=0.023419824048330512 lookSource=pad',
    'steer=0.0203828519439295 pitch=0.006674031167481341 yaw=0.0203828519439295 lookSource=pad',
    'pitch=-0 lookSource=pad',
    'pitch=-0 lookSource=pad',
    'pitch=-0 lookSource=pad',
    'pitch=-0 lookSource=pad',
    'pitch=-0 lookSource=pad',
    'pitch=-0 lookSource=pad',
    'pitch=-0 lookSource=pad',
    'pitch=-0 lookSource=pad',
    'pitch=-0 lookSource=pad',
    'pitch=-0 lookSource=pad',
    'pitch=-0 lookSource=pad',
    'pitch=-0 lookSource=pad',
    'pitch=-0 lookSource=pad',
    'pitch=-0 lookSource=pad',
    'pitch=-0 lookSource=pad',
    'pitch=-0 lookSource=pad',
    'pitch=-0 lookSource=pad',
    'pitch=-0 lookSource=pad',
    'pitch=-0 lookSource=pad',
    'pitch=-0 lookSource=pad',
    'pitch=-0 lookSource=pad',
    'pitch=-0 lookSource=pad',
    'pitch=-0 lookSource=pad',
    'pitch=-0 lookSource=pad',
    'pitch=-0 lookSource=pad',
    'pitch=-0 lookSource=pad',
    'pitch=-0 lookSource=pad',
  ],
};

test('without a touch source the output is bit-identical to an Input that never had one', () => {
  const variants = [
    ['defaults', () => {}],
    [
      'mouse steering + inverted air pitch',
      (s) => {
        s.controls.mouseSteering = true;
        s.controls.invertAirPitch = true;
      },
    ],
  ];
  const moved = ['throttle', 'steer', 'pitch', 'yaw', 'roll', 'jump', 'boost', 'handbrake'];
  moved.push('a.toggleBallCam', 'pa.toggleBallCam', 'a.pause', 'held.scoreboard', 'look.x');
  for (const [name, configure] of variants) {
    const base = scriptedRun('never', configure);
    assert.deepEqual(base.map(goldenLine), GOLDEN[name], `${name}: same output as before touch support`);
    // The script really exercises the inputs (else the comparison proves nothing).
    const flat = base.flat();
    for (const key of moved) {
      assert.ok(
        flat.some(([k, v]) => k === key && v !== 0 && v !== false),
        `${name}: the script moves ${key}`,
      );
    }
    for (const mode of ['null', 'idle']) {
      const run = scriptedRun(mode, configure);
      assert.equal(run.length, base.length);
      assert.deepEqual(run.map(goldenLine), GOLDEN[name], `${name} / ${mode}: same output as before touch support`);
      for (let i = 0; i < base.length; i++) {
        for (let j = 0; j < base[i].length; j++) {
          const [k, v] = base[i][j];
          const [k2, v2] = run[i][j];
          assert.equal(k2, k);
          assert.ok(Object.is(v2, v), `${name} / ${mode}: sample ${i} ${k} = ${v2}, baseline ${v}`);
        }
      }
    }
  }
});

test('touch jump, boost and powerslide reach CarControls; the stick drives throttle, steer, pitch, yaw', () => {
  const { sample, ts } = setup();
  ts.press(TB.JUMP);
  let o = sample();
  assert.equal(o.jump, true);
  assert.equal(o.boost, false);
  ts.release(TB.JUMP);
  ts.press(TB.BOOST);
  o = sample();
  assert.equal(o.jump, false);
  assert.equal(o.boost, true);
  ts.release(TB.BOOST);
  ts.press(TB.DRIFT);
  o = sample();
  assert.equal(o.boost, false);
  assert.equal(o.handbrake, true);
  ts.release(TB.DRIFT);
  o = sample();
  assert.equal(o.handbrake, false);

  ts.setStick(0.5, 0.8);
  o = sample();
  near(o.throttle, 0.8);
  near(o.pitch, -0.8); // up = nose down, like W
  near(o.steer, 0.5);
  near(o.yaw, 0.5);
  assert.equal(o.roll, 0);
  ts.setStick(-0.3, -0.6);
  o = sample();
  near(o.throttle, -0.6);
  near(o.pitch, 0.6);
  near(o.steer, -0.3);
  near(o.yaw, -0.3);
  ts.setStick(0, 0);
  o = sample();
  assert.deepEqual(o, emptyControls());
});

test('touch sums with keyboard and gamepad and is clamped; invertAirPitch flips it', () => {
  const pad = makePad();
  const { sample, ts, target, settings, input } = setup({ pad });
  target.key('KeyW');
  ts.setStick(0, 0.6);
  let o = sample();
  assert.equal(o.throttle, 1, 'W + stick up clamps to 1');
  assert.equal(o.pitch, -1);
  press(pad, GP.LT, 1);
  o = sample();
  near(o.throttle, 0.6);
  target.keyUp('KeyW');
  release(pad, GP.LT);
  settings.controls.invertAirPitch = true;
  input.settingsChanged();
  o = sample();
  near(o.pitch, 0.6); // stick up = nose up when inverted
  press(pad, GP.A);
  o = sample();
  assert.equal(o.jump, true, 'booleans OR');
});

test('DRIFT + stick X rolls instead of yawing (ground steering unaffected)', () => {
  const { sample, ts } = setup();
  ts.setStick(0.7, 0);
  let o = sample();
  near(o.yaw, 0.7);
  assert.equal(o.roll, 0);
  ts.press(TB.DRIFT);
  o = sample();
  assert.equal(o.yaw, 0);
  near(o.roll, 0.7);
  near(o.steer, 0.7);
  assert.equal(o.handbrake, true);
  ts.setStick(-1, 0);
  o = sample();
  assert.equal(o.roll, -1);
  ts.release(TB.DRIFT);
  o = sample();
  assert.equal(o.roll, 0);
  assert.equal(o.yaw, -1);
});

test('touch CAM: one toggleBallCam edge on actions, never padActions; holding fires no second edge', () => {
  const { sample, ts, input } = setup();
  ts.press(TB.CAM);
  sample();
  assert.equal(input.actions.toggleBallCam, true);
  assert.equal(input.padActions.toggleBallCam, false);
  input.consumeActions();
  for (let i = 0; i < 5; i++) {
    sample();
    assert.equal(input.actions.toggleBallCam, false, 'held: no repeat');
  }
  ts.release(TB.CAM);
  sample();
  assert.equal(input.actions.toggleBallCam, false);
  ts.press(TB.CAM);
  ts.release(TB.CAM); // a tap between two samples
  sample();
  assert.equal(input.actions.toggleBallCam, true, 'edge again after the release');
  assert.equal(input.padActions.toggleBallCam, false);
});

test('touch PAUSE sets actions.pause and actions.back, never padActions; RESET is the training reset only', () => {
  const { sample, ts, input } = setup();
  ts.press(TB.PAUSE);
  sample();
  assert.equal(input.actions.pause, true);
  assert.equal(input.actions.back, true);
  assert.equal(input.padActions.pause, false);
  assert.equal(input.padActions.back, false);
  input.consumeActions();
  sample();
  assert.equal(input.actions.pause, false, 'held: no repeat');
  ts.release(TB.PAUSE);
  sample();

  ts.press(TB.RESET);
  ts.release(TB.RESET);
  sample();
  assert.equal(input.actions.trainingReset, true);
  assert.equal(input.padActions.trainingReset, false);
  assert.equal(input.actions.back, false, 'not a menu back (Backspace is, RESET is not)');
  assert.equal(input.actions.reset, false, 'not the kickoff reset');
});

test('a jump tap between two samples is true in exactly one sample', () => {
  const { sample, ts } = setup();
  sample();
  ts.press(TB.JUMP);
  ts.release(TB.JUMP);
  const jumps = [];
  for (let i = 0; i < 4; i++) jumps.push(sample().jump);
  assert.deepEqual(jumps, [true, false, false, false]);
});

test('touch goes through blockJumpUntilRelease, latchEdges and the rebind capture like the keyboard', async () => {
  const { sample, ts, input } = setup();
  ts.press(TB.JUMP);
  assert.equal(sample().jump, true);
  input.blockJumpUntilRelease();
  assert.equal(sample().jump, false);
  ts.release(TB.JUMP);
  assert.equal(sample().jump, false);
  ts.press(TB.JUMP);
  assert.equal(sample().jump, true);
  ts.release(TB.JUMP);

  sample();
  ts.press(TB.CAM); // still held when the menu closes
  input.latchEdges();
  sample();
  assert.equal(input.actions.toggleBallCam, false, 'held through the latch: no edge');
  ts.release(TB.CAM);

  sample();
  const p = input.startRebind('jump', 'kbm');
  await new Promise((resolve) => setTimeout(resolve, 0));
  ts.setStick(1, 1);
  ts.press(TB.BOOST);
  ts.press(TB.PAUSE);
  const o = sample();
  assert.deepEqual(o, emptyControls(), 'driving is ignored while capturing');
  assert.equal(input.actions.pause, false);
  assert.equal(input.rebinding, true, 'touch is not a bindable device');
  input.cancelRebind();
  assert.equal(await p, null);
  sample();
  assert.equal(input.actions.pause, false, 'the press made during the capture fires no edge after it');
  assert.equal(sample().boost, true);
});

test('touch never moves the camera look; setTouchSource(null) drops touch at once', () => {
  const { sample, ts, input } = setup();
  ts.setStick(1, 1);
  ts.press(TB.BOOST);
  let o = sample();
  assert.equal(o.boost, true);
  assert.deepEqual([input.look.x, input.look.y, input.lookSource], [0, 0, 'none']);
  input.setTouchSource(null);
  o = sample();
  assert.deepEqual(o, emptyControls());
  input.setTouchSource(ts);
  assert.equal(sample().boost, true, 'the same state drives again once plugged back in');
});

/** A fake touch source that writes `vals` (by action name) and 0 elsewhere. */
function fakeSource(vals = {}) {
  return {
    vals,
    read(out) {
      out.fill(0);
      for (const k in this.vals) out[ACTION_IDS.indexOf(k)] = this.vals[k];
    },
  };
}

test('the camera look actions ignore the touch source, even one that writes them', () => {
  const { sample, input } = setup({ touch: false });
  // One side of each axis only: 1 on both sides would cancel out and hide a leak.
  input.setTouchSource(fakeSource({ lookRight: 1, lookDown: 1 }));
  for (let i = 0; i < 3; i++) {
    sample();
    assert.deepEqual([input.look.x, input.look.y, input.lookSource], [0, 0, 'none'], `sample ${i}`);
  }
});

test('a faulty source is clamped to 0..1 per action: it never cancels the keyboard or the pad', () => {
  const pad = makePad();
  const { sample, target, input } = setup({ pad, touch: false });
  const src = fakeSource();
  input.setTouchSource(src);
  target.key('KeyW');
  target.key('ShiftLeft');
  press(pad, GP.A);
  press(pad, GP.B);
  src.vals = { throttle: NaN, powerslide: NaN, jump: NaN, boost: -5, steerLeft: -Infinity };
  let o = sample();
  assert.deepEqual([o.throttle, o.handbrake, o.jump, o.boost, o.steer], [1, true, true, true, 0], 'NaN / negative = 0');
  src.vals = { reverse: 3, steerRight: Infinity, pitchUp: 1e9 };
  o = sample();
  assert.equal(o.throttle, 0, 'reverse 3 is one full press: W - S = 0, not -1');
  assert.equal(o.steer, 1);
  assert.equal(o.pitch, 0, 'pitchUp 1e9 = 1 cancels W (pitchDown) exactly');
  for (const k of ['throttle', 'steer', 'pitch', 'yaw', 'roll']) assert.ok(Number.isFinite(o[k]), k);
  target.keyUp('KeyW');
  target.keyUp('ShiftLeft');
  release(pad, GP.A);
  release(pad, GP.B);
  src.vals = { pause: NaN };
  sample();
  assert.equal(input.actions.pause, false, 'NaN never fires an edge');
  src.vals = { pause: 2 };
  sample();
  assert.equal(input.actions.pause, true);
  assert.equal(input.padActions.pause, false);
});

test("Input's own release (page hidden, focus lost) also releases the touch source", () => {
  const { sample, ts, doc, target, input } = setup();
  ts.setStick(0, 1);
  ts.press(TB.BOOST);
  ts.press(TB.DRIFT);
  assert.equal(sample().boost, true);
  doc.visibilityState = 'hidden';
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(ts.isHeld(TB.BOOST), false);
  assert.deepEqual([ts.stickX, ts.stickY], [0, 0]);
  assert.deepEqual(sample(), emptyControls());
  doc.visibilityState = 'visible';
  ts.press(TB.JUMP);
  assert.equal(sample().jump, true);
  target.dispatchEvent(new Event('blur'));
  assert.equal(ts.isHeld(TB.JUMP), false);
  assert.deepEqual(sample(), emptyControls());
  // releaseAll is optional: a source without it is left alone.
  input.setTouchSource(fakeSource({ boost: 1 }));
  target.dispatchEvent(new Event('blur'));
  assert.equal(sample().boost, true);
  input.dispose();
});

// ---- Input.gamepadPresses (touch mode turns off on a pad press) ----------------------------

test('gamepadPresses counts button rising edges, once per press, without changing the output', () => {
  const pad = makePad();
  const { input, sample } = setup({ pad, touch: false });
  sample();
  assert.equal(input.gamepadPresses, 0, 'a connected pad alone is no press');
  pad.axes[0] = 0.9;
  sample();
  assert.equal(input.gamepadPresses, 0, 'sticks are not presses');
  pad.axes[0] = 0;
  press(pad, GP.A);
  const out = sample();
  assert.equal(input.gamepadPresses, 1);
  assert.equal(out.jump, true, 'the press still drives as before');
  sample();
  sample();
  assert.equal(input.gamepadPresses, 1, 'held: no new press');
  release(pad, GP.A);
  sample();
  press(pad, GP.B);
  press(pad, GP.START);
  sample();
  assert.equal(input.gamepadPresses, 3, 'one per button');
  input.dispose();
});

// ---- TouchRouter (src/input/touchRouter.ts) ------------------------------------------------

const { TouchRouter, HIT_SLOP, STICK_EDGE_REACH, emptyLayout } = await import('../src/input/touchRouter.ts');

/** A landscape phone, 800 x 400: the stick zone on the left half, the buttons bottom / top right. */
function routerSetup() {
  const ts = new TouchState();
  const layout = emptyLayout();
  layout.bounds = { left: 0, top: 0, right: 800, bottom: 400 };
  layout.zone = { left: 30, top: 72, right: 400, bottom: 400 };
  layout.stickRadius = 60;
  const set = (b, cx, cy, r) => Object.assign(layout.buttons[b], { cx, cy, r });
  set(TB.BOOST, 690, 320, 50);
  set(TB.JUMP, 575, 330, 40);
  set(TB.DRIFT, 690, 220, 32);
  set(TB.PAUSE, 740, 50, 26);
  set(TB.CAM, 670, 50, 26);
  set(TB.RESET, 600, 50, 0); // hidden outside training
  const router = new TouchRouter(ts, layout);
  return { ts, router, layout };
}

test('router: a finger in the zone floats the stick at its landing point; the offset is the deflection', () => {
  const { ts, router } = routerSetup();
  router.down(1, 150, 250);
  assert.equal(router.stickActive, true);
  assert.deepEqual([router.stickX, router.stickY], [150, 250]);
  assert.deepEqual(readMap(ts), {}, 'no deflection at the landing point');
  router.move(1, 150, 190); // 60 px up = the radius
  near(ts.stickY, stickVector(0, -60, 60).y);
  near(ts.stickX, 0);
  assert.equal(readMap(ts).throttle, 1);
  router.move(1, 450, 250); // far right: the knob stops at the radius
  near(router.knobX, 60);
  near(router.knobY, 0);
  near(ts.stickX, 1);
  router.up(1, 450, 250);
  assert.equal(router.stickActive, false);
  assert.deepEqual([ts.stickX, ts.stickY, router.knobX, router.knobY], [0, 0, 0, 0]);
  assert.deepEqual(readMap(ts), {});
});

test('router: the stick centre stays inside the screen: a landing in the bottom-left corner reaches full left and full reverse', () => {
  const { ts, router, layout } = routerSetup();
  const reach = STICK_EDGE_REACH * layout.stickRadius;
  router.down(1, 34, 396); // 4 px inside the zone's left edge and above the screen's bottom
  assert.deepEqual([router.stickX, router.stickY], [reach, 400 - reach], 'the centre moved in');
  router.move(1, 0, 400 - reach); // the screen's left edge
  assert.equal(ts.stickX, -1, 'full left');
  near(ts.stickY, 0);
  let m = readMap(ts);
  assert.equal(m.steerLeft, 1);
  assert.equal(m.yawLeft, 1);
  router.move(1, reach, 400); // the screen's bottom edge
  assert.equal(ts.stickY, -1, 'full reverse / pitch up');
  m = readMap(ts);
  assert.equal(m.reverse, 1);
  assert.equal(m.pitchUp, 1);
  router.up(1, reach, 400);
  router.down(2, 150, 250); // away from the edges: the landing point, no deflection
  assert.deepEqual([router.stickX, router.stickY], [150, 250]);
  assert.deepEqual(readMap(ts), {});
  router.up(2, 150, 250);
  layout.bounds = { left: 0, top: 0, right: 0, bottom: 0 }; // not measured: no limit
  router.down(3, 34, 396);
  assert.deepEqual([router.stickX, router.stickY], [34, 396]);
});

test('router: one stick at a time; the left edge strip and the top strip start nothing', () => {
  const { ts, router } = routerSetup();
  router.down(1, 150, 250);
  router.down(2, 300, 300); // a second thumb in the zone
  router.move(2, 360, 300);
  assert.equal(ts.stickX, 0);
  assert.deepEqual([router.stickX, router.stickY], [150, 250]);
  router.up(1, 150, 250);
  router.move(2, 300, 200);
  assert.equal(router.stickActive, false, 'it does not take the stick over either');
  router.up(2, 300, 200);
  router.down(3, 12, 250); // the back-gesture edge
  router.down(4, 150, 40); // the top strip (scorebug)
  router.move(3, 200, 250);
  router.move(4, 150, 200);
  assert.equal(router.stickActive, false);
  assert.deepEqual(readMap(ts), {});
  assert.equal(router.fingerCount, 2, 'tracked so their lift is seen, holding nothing');
});

test('router: big buttons hold; a slide switches; BOOST stays held once held; the gap keeps the button', () => {
  const { ts, router } = routerSetup();
  router.down(1, 575, 330);
  assert.deepEqual(readMap(ts), { jump: 1 });
  router.move(1, 628, 330); // the gap between JUMP (r 40) and BOOST (r 50): no switch, no flicker
  assert.deepEqual(readMap(ts), { jump: 1 });
  router.move(1, 660, 325); // into BOOST
  assert.deepEqual(readMap(ts), { boost: 1 }, 'from JUMP: jump released');
  router.move(1, 575, 330); // back to JUMP: BOOST stays held by this finger
  assert.deepEqual(readMap(ts), { jump: 1, boost: 1 });
  router.move(1, 690, 220); // DRIFT: jump released, boost kept
  assert.deepEqual(readMap(ts), { boost: 1, powerslide: 1, airRoll: 1 });
  router.move(1, 690, 320); // back on BOOST: no second press of it
  assert.deepEqual(readMap(ts), { boost: 1 });
  router.up(1, 690, 320);
  assert.deepEqual(readMap(ts), {});
  assert.equal(ts.isHeld(TB.BOOST), false, 'every press released exactly once');
});

test('router: a landing hits within HIT_SLOP radii, a slide needs the button itself; the right half starts empty', () => {
  const { ts, router } = routerSetup();
  router.down(1, 690 - 50 * (HIT_SLOP - 0.05), 320); // just off BOOST's edge, inside the slop
  assert.deepEqual(readMap(ts), { boost: 1 });
  router.up(1, 690, 320);
  router.down(2, 500, 200); // right half, off every button: holds nothing
  assert.deepEqual(readMap(ts), {});
  router.move(2, 575 - 40 * 1.1, 330); // within JUMP's slop but outside its circle: not yet
  assert.deepEqual(readMap(ts), {});
  router.move(2, 575, 330);
  assert.deepEqual(readMap(ts), { jump: 1 }, 'sliding onto a button presses it');
  router.move(2, 740, 50); // a slide never reaches a tap button
  router.up(2, 740, 50);
  assert.deepEqual(readMap(ts), {});
});

test('router: tap buttons fire once on a lift over them; sliding away or a cancel does not; hidden ones never hit', () => {
  const { ts, router } = routerSetup();
  router.down(1, 740, 50);
  assert.equal(router.pendingTaps, 1 << TB.PAUSE);
  assert.deepEqual(readMap(ts), {}, 'nothing until the lift');
  router.up(1, 742, 52);
  assert.equal(router.pendingTaps, 0);
  assert.deepEqual(readMap(ts), { pause: 1 }, 'one read');
  assert.deepEqual(readMap(ts), {});
  router.down(2, 670, 50);
  router.move(2, 670, 150); // slid away
  router.move(2, 670, 50); // and back: still cancelled
  router.up(2, 670, 50);
  assert.deepEqual(readMap(ts), {});
  router.down(3, 670, 50);
  router.up(3, 670, 50, true); // pointercancel / lost capture
  assert.deepEqual(readMap(ts), {});
  router.down(4, 600, 50); // RESET hidden (r 0)
  router.up(4, 600, 50);
  assert.deepEqual(readMap(ts), {});
  router.down(5, 740, 50); // two fingers on PAUSE: pending until the last one lifts or slides off
  router.down(6, 744, 52);
  router.up(5, 740, 50, true);
  assert.equal(router.pendingTaps, 1 << TB.PAUSE);
  router.move(6, 740, 200);
  assert.equal(router.pendingTaps, 0);
  router.up(6, 740, 200);
  assert.equal(router.pendingTaps, 0);
  router.down(7, 670, 50);
  router.releaseAll();
  assert.equal(router.pendingTaps, 0);
  assert.deepEqual(readMap(ts), {});
});

test('router: fingers are counted; releaseAll forgets them and their late lifts drop nothing', () => {
  const { ts, router } = routerSetup();
  router.down(1, 690, 320);
  router.down(2, 700, 330);
  router.up(1, 690, 320);
  assert.equal(ts.isHeld(TB.BOOST), true, 'the other finger still holds it');
  router.up(1, 690, 320); // a second lift of the same finger (pointerup, then lostpointercapture)
  assert.equal(ts.isHeld(TB.BOOST), true);
  router.down(3, 150, 250);
  router.move(3, 150, 200);
  router.releaseAll();
  assert.equal(router.fingerCount, 0);
  assert.equal(router.stickActive, false);
  assert.deepEqual(readMap(ts), {});
  router.down(4, 690, 320);
  router.up(2, 700, 330); // a finger forgotten by releaseAll lifts now
  assert.equal(ts.isHeld(TB.BOOST), true, 'the new hold survives');
  router.down(4, 575, 330); // the same id landing again (missed lift): its old hold goes first
  assert.equal(ts.isHeld(TB.BOOST), false);
  assert.equal(ts.isHeld(TB.JUMP), true);
});

test('router through Input: one thumb on BOOST sliding to JUMP takes off with boost', () => {
  const { sample, ts, input } = setup();
  const router = new TouchRouter(ts, routerSetup().layout);
  router.down(1, 690, 320);
  assert.equal(sample().boost, true);
  router.move(1, 575, 330);
  const out = sample();
  assert.equal(out.boost, true);
  assert.equal(out.jump, true);
  router.up(1, 575, 330);
  const after = sample();
  assert.equal(after.boost, false);
  assert.equal(after.jump, false);
  input.dispose();
});

// ---- Touch mode decisions (src/input/touchMode.ts) ---------------------------------------

const { keyLeavesTouchMode, pointerTouchMode, MENU_KEYS } = await import('../src/input/touchMode.ts');
const { DEFAULT_KBM, KEYBOARD_ONLY_KBM } = await import('../src/input/bindings.ts');

test('touch mode: a menu key or a bound key leaves it; volume / media keys, code "", unbound keys and text fields do not', () => {
  for (const code of ['AudioVolumeUp', 'AudioVolumeDown', 'AudioVolumeMute', 'MediaPlayPause', 'MediaTrackNext', 'LaunchApp1', 'BrowserBack', '', undefined, 7]) {
    assert.equal(keyLeavesTouchMode(code, false, DEFAULT_KBM), false, String(code));
  }
  for (const code of MENU_KEYS) assert.equal(keyLeavesTouchMode(code, false, DEFAULT_KBM), true, code);
  for (const code of ['Escape', 'Enter', 'Backspace', 'ArrowUp', 'KeyW', 'Space', 'Tab']) assert.ok(MENU_KEYS.has(code), code);
  assert.equal(keyLeavesTouchMode('ShiftLeft', false, DEFAULT_KBM), true, 'powerslide / air roll');
  assert.equal(keyLeavesTouchMode('KeyQ', false, DEFAULT_KBM), true, 'air roll left');
  assert.equal(keyLeavesTouchMode('KeyZ', false, DEFAULT_KBM), false, 'unbound in the default layout');
  assert.equal(keyLeavesTouchMode('KeyZ', false, KEYBOARD_ONLY_KBM), true, 'bound in the keyboard-only layout');
  const rebound = { ...DEFAULT_KBM, boost: { kind: 'key', code: 'KeyG' } };
  assert.equal(keyLeavesTouchMode('KeyG', false, rebound), true, 'the live profile counts');
  assert.equal(keyLeavesTouchMode('KeyG', false, DEFAULT_KBM), false);
  assert.equal(keyLeavesTouchMode('KeyF', false, DEFAULT_KBM), true, 'free play reset car');
  assert.equal(keyLeavesTouchMode('KeyW', true, DEFAULT_KBM), false, 'typed into a text field');
  assert.equal(keyLeavesTouchMode('ShiftLeft', true, DEFAULT_KBM), false);
});

test('touch mode: a finger or a pen turns it on, a mouse off, an unknown pointer leaves it', () => {
  assert.equal(pointerTouchMode('touch'), true);
  assert.equal(pointerTouchMode('pen'), true);
  assert.equal(pointerTouchMode('mouse'), false);
  assert.equal(pointerTouchMode(''), null);
  assert.equal(pointerTouchMode('kinect'), null);
});

// ---- Phone platform decisions (src/input/touchMode.ts) -----------------------------------

const { shouldAutoFullscreen, shouldShowInstallHint } = await import('../src/input/touchMode.ts');

/** Browsers as TouchControls.platformEnv() reads them. */
const PLATFORMS = {
  androidPhone: { coarse: true, orientationLock: true, elementFullscreen: true, fullscreen: false, standalone: false },
  iPhone: { coarse: true, orientationLock: false, elementFullscreen: false, fullscreen: false, standalone: false },
  iPhoneHomeScreen: { coarse: true, orientationLock: false, elementFullscreen: false, fullscreen: false, standalone: true },
  iPad: { coarse: true, orientationLock: false, elementFullscreen: true, fullscreen: false, standalone: false },
  // An app's WebView that does not handle fullscreen (or an iframe without allowfullscreen) reports fullscreenEnabled false.
  androidWebView: { coarse: true, orientationLock: true, elementFullscreen: false, fullscreen: false, standalone: false },
  // Desktop Chrome has screen.orientation.lock (it rejects); a touch laptop / Chromebook has a fine primary pointer.
  desktopChrome: { coarse: false, orientationLock: true, elementFullscreen: true, fullscreen: false, standalone: false },
  touchLaptop: { coarse: false, orientationLock: true, elementFullscreen: true, fullscreen: false, standalone: false },
  macSafari: { coarse: false, orientationLock: false, elementFullscreen: true, fullscreen: false, standalone: false },
};

test('auto fullscreen: only a finger device that locks the orientation (Android), never desktops, touch laptops or iPads', () => {
  assert.equal(shouldAutoFullscreen(PLATFORMS.androidPhone), true);
  for (const name of ['iPhone', 'iPhoneHomeScreen', 'iPad', 'androidWebView', 'desktopChrome', 'touchLaptop', 'macSafari']) {
    assert.equal(shouldAutoFullscreen(PLATFORMS[name]), false, name);
  }
  assert.equal(shouldAutoFullscreen({ ...PLATFORMS.androidPhone, fullscreen: true }), false, 'already fullscreen');
  assert.equal(shouldAutoFullscreen({ ...PLATFORMS.androidPhone, elementFullscreen: false }), false, 'no element fullscreen');
  assert.equal(shouldAutoFullscreen({ ...PLATFORMS.androidPhone, coarse: false }), false, 'a mouse / trackpad first');
});

test('install hint: an iPhone in a browser tab, once; never at home screen, on Android, with element fullscreen or without a finger', () => {
  assert.equal(shouldShowInstallHint(PLATFORMS.iPhone, false), true);
  assert.equal(shouldShowInstallHint(PLATFORMS.iPhone, true), false, 'shown before');
  for (const name of ['iPhoneHomeScreen', 'androidPhone', 'androidWebView', 'iPad', 'desktopChrome', 'touchLaptop', 'macSafari']) {
    assert.equal(shouldShowInstallHint(PLATFORMS[name], false), false, name);
  }
});
