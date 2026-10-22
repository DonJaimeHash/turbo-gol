// Self-check for src/ai/Bot.ts. Runs on node (>= 23.6, type stripping) without the wasm:
//   node --test tests/bot.test.mjs
// A fake SimStateView is a Float32Array laid out per src/sim/types.ts plus a static ball prediction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Node does not add extensions to relative imports; the TS sources use bundler-style extensionless
// specifiers, so resolve "./x" -> "./x.ts" when the extensionless path does not exist.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z]+$/i.test(specifier) && context.parentURL) {
      const candidate = new URL(specifier + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});

const types = await import(new URL('../src/sim/types.ts', import.meta.url).href);
const bot = await import(new URL('../src/ai/Bot.ts', import.meta.url).href);
const m = await import(new URL('../src/ai/math.ts', import.meta.url).href);
const { KICKOFF_SPAWNS } = await import(new URL('../src/sim/constants.ts', import.meta.url).href);

const { Bot, predictBallAt, firstReachable, steerToward, aimInAir, DIFFICULTY_PARAMS } = bot;
const {
  STATE_BUFFER_FLOATS, BALL_PRED_TICKS, BALL_PRED_STRIDE, BALL_OFFSET, B_POS, B_VEL, CARS_OFFSET, CAR_STRIDE,
  C_ID, C_TEAM, C_POS, C_ROT, C_VEL, C_ANG_VEL, C_BOOST, C_IS_ON_GROUND, C_IS_FLIPPING, C_IS_DEMOED, PADS_OFFSET, PAD_STRIDE,
  P_IS_ACTIVE, NUM_BOOST_PADS, H_NUM_CARS, TICK_DT, Team, emptyControls,
} = types;

function makeState(numCars = 2) {
  const buf = new Float32Array(STATE_BUFFER_FLOATS);
  const ballPred = new Float32Array(BALL_PRED_TICKS * BALL_PRED_STRIDE);
  buf[H_NUM_CARS] = numCars;
  for (let i = 0; i < NUM_BOOST_PADS; i++) buf[PADS_OFFSET + i * PAD_STRIDE + P_IS_ACTIVE] = 1;
  const state = {
    buf,
    ballPred,
    get tickCount() { return buf[0]; },
    get numCars() { return buf[H_NUM_CARS]; },
    carOffset: (slot) => CARS_OFFSET + slot * CAR_STRIDE,
    slotOf(id) { for (let s = 0; s < this.numCars; s++) if (buf[this.carOffset(s) + C_ID] === id) return s; return -1; },
  };
  return state;
}

/** Ball at rest at (x,y,z); prediction = same point for the whole horizon. */
function setBall(state, x, y, z = 93.15, vx = 0, vy = 0, vz = 0) {
  const b = state.buf;
  b[BALL_OFFSET + B_POS] = x; b[BALL_OFFSET + B_POS + 1] = y; b[BALL_OFFSET + B_POS + 2] = z;
  b[BALL_OFFSET + B_VEL] = vx; b[BALL_OFFSET + B_VEL + 1] = vy; b[BALL_OFFSET + B_VEL + 2] = vz;
  for (let i = 0; i < BALL_PRED_TICKS; i++) {
    const t = (i + 1) * TICK_DT;
    const o = i * BALL_PRED_STRIDE;
    state.ballPred[o] = x + vx * t; state.ballPred[o + 1] = y + vy * t; state.ballPred[o + 2] = z + vz * t;
    state.ballPred[o + 3] = vx; state.ballPred[o + 4] = vy; state.ballPred[o + 5] = vz;
  }
}

/** Place a car: yaw in rad (sim: forward = (cos, sin, 0), right = (-sin, cos, 0), up = +z). */
function setCar(state, slot, { id = slot + 1, team = Team.Blue, x = 0, y = 0, z = 17, yaw = Math.PI / 2, vx = 0, vy = 0, vz = 0, boost = 33, onGround = 1, fwd, right, up } = {}) {
  const b = state.buf;
  const o = state.carOffset(slot);
  b[o + C_ID] = id; b[o + C_TEAM] = team;
  b[o + C_POS] = x; b[o + C_POS + 1] = y; b[o + C_POS + 2] = z;
  const f = fwd ?? [Math.cos(yaw), Math.sin(yaw), 0];
  const r = right ?? [-Math.sin(yaw), Math.cos(yaw), 0];
  const u = up ?? [0, 0, 1];
  for (let i = 0; i < 3; i++) { b[o + C_ROT + i] = f[i]; b[o + C_ROT + 3 + i] = r[i]; b[o + C_ROT + 6 + i] = u[i]; }
  b[o + C_VEL] = vx; b[o + C_VEL + 1] = vy; b[o + C_VEL + 2] = vz;
  b[o + C_ANG_VEL] = 0; b[o + C_ANG_VEL + 1] = 0; b[o + C_ANG_VEL + 2] = 0;
  b[o + C_BOOST] = boost;
  b[o + C_IS_ON_GROUND] = onGround;
  b[o + C_IS_FLIPPING] = 0;
  return o;
}

function assertFiniteControls(c, label) {
  for (const k of ['throttle', 'steer', 'pitch', 'yaw', 'roll']) {
    assert.ok(Number.isFinite(c[k]), `${label}: ${k} is ${c[k]}`);
    assert.ok(c[k] >= -1 && c[k] <= 1, `${label}: ${k} out of range ${c[k]}`);
  }
  for (const k of ['jump', 'boost', 'handbrake']) assert.equal(typeof c[k], 'boolean', `${label}: ${k} not boolean`);
}

test('kickoff: drives at the ball with boost from the blue spawn', () => {
  const state = makeState();
  setBall(state, 0, 0);
  const [sx, sy, syaw] = KICKOFF_SPAWNS[0];
  setCar(state, 0, { team: Team.Blue, x: sx, y: sy, yaw: syaw });
  setCar(state, 1, { team: Team.Red, x: -sx, y: -sy, yaw: syaw + Math.PI });
  const b = new Bot({ team: Team.Blue, difficulty: 'hard' });
  const out = emptyControls();
  for (let i = 0; i < 4; i++) b.think(state, 0, 1, out);
  assertFiniteControls(out, 'kickoff');
  assert.equal(b.mode, 'kickoff');
  assert.ok(out.throttle > 0, 'throttle > 0 at kickoff');
  assert.ok(out.boost, 'boost at kickoff');
  assert.ok(Math.abs(out.steer) < 0.6, 'spawn already points roughly at the ball');
  // the red car too (mirrored), including the easy bot which otherwise never boosts
  const bo = new Bot({ team: Team.Red, difficulty: 'easy' });
  for (let i = 0; i < 4; i++) bo.think(state, 1, 0, out);
  assert.ok(out.throttle > 0 && out.boost, 'red easy bot boosts at kickoff');
});

test('kickoff: dodges into the ball when close and fast', () => {
  const state = makeState();
  setBall(state, 0, 0);
  setCar(state, 0, { team: Team.Blue, x: 0, y: -400, yaw: Math.PI / 2, vx: 0, vy: 2000 });
  setCar(state, 1, { team: Team.Red, x: 0, y: 3000, yaw: -Math.PI / 2 });
  const b = new Bot({ team: Team.Blue, difficulty: 'medium' });
  const out = emptyControls();
  let sawJump = false;
  let sawFlip = false;
  for (let i = 0; i < 20; i++) {
    b.think(state, 0, 1, out);
    if (out.jump && !sawJump) sawJump = true;
    else if (out.jump && sawJump && out.pitch < -0.9) sawFlip = true;
    if (i === 3) state.buf[state.carOffset(0) + C_IS_ON_GROUND] = 0; // the sim lifts the car off
  }
  assert.ok(sawJump, 'first jump press');
  assert.ok(sawFlip, 'second press with pitch -1 (front flip)');
});

test('steers toward the ball when it is offset to either side', () => {
  for (const side of [1, -1]) {
    const state = makeState();
    const yaw = Math.PI / 2;
    const o = setCar(state, 0, { team: Team.Blue, x: 0, y: -1000, yaw });
    setCar(state, 1, { team: Team.Red, x: 0, y: 4000, yaw: -Math.PI / 2 });
    const right = [state.buf[o + C_ROT + 3], state.buf[o + C_ROT + 4]];
    // ball 1500 ahead and 900 to the car's `side` (right = +1)
    setBall(state, 0 + right[0] * 900 * side, -1000 + 1500 + right[1] * 900 * side);
    const b = new Bot({ team: Team.Blue, difficulty: 'hard' });
    const out = emptyControls();
    for (let i = 0; i < 4; i++) b.think(state, 0, 1, out);
    assertFiniteControls(out, `offset ${side}`);
    assert.equal(b.mode, 'attack');
    assert.ok(out.throttle > 0, 'drives forward');
    assert.ok(Math.sign(out.steer) === side, `steer sign ${out.steer} should match side ${side}`);
  }
});

test('pure helpers: predictBallAt, firstReachable, steerToward', () => {
  const state = makeState();
  setBall(state, 100, 200, 93, 500, 0, 0);
  const out = new Float32Array(6);
  predictBallAt(state, 0, out);
  assert.deepEqual(Array.from(out).map(Math.round), [100, 200, 93, 500, 0, 0]);
  predictBallAt(state, 1, out);
  assert.ok(Math.abs(out[0] - 600) < 10, 'x after 1 s');
  predictBallAt(state, 100, out); // beyond horizon -> last entry
  assert.ok(Math.abs(out[0] - (100 + 500 * 6)) < 10);

  setBall(state, 0, 1000);
  const carPos = m.vec3(0, 0, 17), carVel = m.vec3(0, 0, 0), carFwd = m.vec3(0, 1, 0);
  const t = firstReachable(state, carPos, carVel, carFwd, 0, out);
  assert.ok(t > 0.4 && t < 2.0, `stationary ball 1000 ahead reachable in ${t}s`);
  const tBoost = firstReachable(state, carPos, carVel, carFwd, 100, out);
  assert.ok(tBoost <= t, 'boost does not make it slower');
  const tBehind = firstReachable(state, carPos, carVel, m.vec3(0, -1, 0), 0, out);
  assert.ok(tBehind > t, 'facing away costs a turning penalty');
  setBall(state, 0, 1000, 800); // ball high for the whole horizon -> unreachable on the ground
  assert.equal(firstReachable(state, carPos, carVel, carFwd, 100, out), -1);

  const right = m.vec3(-1, 0, 0);
  assert.ok(steerToward(carFwd, right, carPos, m.vec3(-500, 500, 0)) > 0, 'target on the right -> steer right');
  assert.ok(steerToward(carFwd, right, carPos, m.vec3(500, 500, 0)) < 0, 'target on the left -> steer left');
  assert.equal(steerToward(carFwd, right, carPos, m.vec3(0, 500, 0)), 0);
});

test('physics profile: the stock profile is the default arithmetic; a preset profile changes the reach model', () => {
  const state = makeState();
  setBall(state, 0, 3000);
  const out = new Float32Array(6);
  const carPos = m.vec3(0, 0, 17), carVel = m.vec3(0, 0, 0), carFwd = m.vec3(0, 1, 0);
  const tDefault = firstReachable(state, carPos, carVel, carFwd, 100, out);
  assert.equal(firstReachable(state, carPos, carVel, carFwd, 100, out, bot.TUNING.groundMaxBallZ, 2, m.STOCK_BOT_PHYSICS), tDefault);
  const fast = { ...m.STOCK_BOT_PHYSICS, boostAccelGround: m.BOOST_ACCEL_GROUND * 2, maxBoostSpeed: 2600, boostPerSecond: 0 };
  assert.ok(firstReachable(state, carPos, carVel, carFwd, 100, out, bot.TUNING.groundMaxBallZ, 2, fast) < tDefault, 'more boost, higher top speed: there sooner');
  const slow = { ...m.STOCK_BOT_PHYSICS, boostAccelGround: m.BOOST_ACCEL_GROUND / 2, maxBoostSpeed: 2000 };
  assert.ok(firstReachable(state, carPos, carVel, carFwd, 100, out, bot.TUNING.groundMaxBallZ, 2, slow) > tDefault, 'less boost: later');
  // A bot keeps its profile and thinks without NaN under it.
  const b = new Bot({ team: Team.Blue, physics: fast });
  assert.equal(b.physics, fast);
  assert.equal(new Bot({ team: Team.Blue }).physics, m.STOCK_BOT_PHYSICS);
  // The aerial planner's jump-hold velocities follow the hold acceleration: exactly 1x for stock.
  assert.equal(new Bot({ team: Team.Blue })['holdScale'], 1);
  assert.equal(new Bot({ team: Team.Blue, physics: { ...m.STOCK_BOT_PHYSICS } })['holdScale'], 1);
  const springy = { ...m.STOCK_BOT_PHYSICS, jumpHoldAccel: m.JUMP_HOLD_ACCEL * 1.5 };
  assert.ok(Math.abs(new Bot({ team: Team.Blue, physics: springy })['holdScale'] - 1.5) < 1e-12);
  setCar(state, 0, { team: Team.Blue, x: 0, y: 0 });
  setCar(state, 1, { team: Team.Red, x: 0, y: 4000, yaw: -Math.PI / 2 });
  const c = emptyControls();
  for (let i = 0; i < 30; i++) {
    b.think(state, 0, -1, c);
    assertFiniteControls(c, 'preset profile');
  }
});

test('air: rolled car levels out with the correct roll sign and nothing is NaN', () => {
  const out = emptyControls();
  const th = 0.5; // rolled right by 0.5 rad (up tilted toward +right)
  const fwd = m.vec3(1, 0, 0), right = m.vec3(0, Math.cos(th), -Math.sin(th)), up = m.vec3(0, Math.sin(th), Math.cos(th));
  aimInAir(fwd, right, up, m.vec3(), m.vec3(1, 0, 0), out);
  assert.ok(out.roll < 0, `rolled right -> roll left, got ${out.roll}`);
  assert.ok(Math.abs(out.pitch) < 1e-6 && Math.abs(out.yaw) < 1e-6);
  // nose-down car wants pitch up
  aimInAir(m.vec3(0, 0, -1), m.vec3(0, 1, 0), m.vec3(1, 0, 0), m.vec3(), m.vec3(1, 0, 0), out);
  assert.ok(out.pitch > 0.5, `nose down -> pitch up, got ${out.pitch}`);
  assertFiniteControls(out, 'air');

  // through the bot: airborne, upside down, no ball play -> recover mode, no boost
  const state = makeState();
  setBall(state, 2000, 3000);
  setCar(state, 0, { team: Team.Blue, x: 0, y: 0, z: 800, up: [0, 0, -1], fwd: [1, 0, 0], right: [0, -1, 0], onGround: 0, vz: -200 });
  setCar(state, 1, { team: Team.Red, x: 0, y: 4000, yaw: -Math.PI / 2 });
  const b = new Bot({ team: Team.Blue, difficulty: 'hard' });
  for (let i = 0; i < 3; i++) b.think(state, 0, 1, out);
  assert.equal(b.mode, 'recover');
  assert.ok(!out.boost);
  assert.ok(Math.abs(out.roll) > 0.5, 'upside down -> strong roll');
  assertFiniteControls(out, 'recover');
});

test('defends: ball rolling at our goal with the opponent closer -> shadow/clear, never NaN', () => {
  const state = makeState();
  setBall(state, 300, -1500, 93, 0, -1200, 0);
  setCar(state, 0, { team: Team.Blue, x: 2500, y: 1000, yaw: Math.PI / 2 });
  setCar(state, 1, { team: Team.Red, x: 300, y: -800, yaw: -Math.PI / 2 });
  const b = new Bot({ team: Team.Blue, difficulty: 'hard' });
  const out = emptyControls();
  for (let i = 0; i < 6; i++) b.think(state, 0, 1, out);
  assert.equal(b.mode, 'defend');
  assert.ok(b.target[1] < -1500, 'target is goal-side of the ball');
  assertFiniteControls(out, 'defend');
});

test('considers every opponent in the state: the nearest one to the ball decides, whatever opponentSlot says', () => {
  // ball rolling at the blue goal; the opponent named by opponentSlot (slot 1) is far away but a
  // second red car (slot 2) is on the ball -> the bot must still shadow / defend.
  // (slow roll so the ball itself is reachable: only the opponent's position decides)
  const state = makeState(3);
  setBall(state, 300, -1500, 93, 0, -400, 0);
  setCar(state, 0, { team: Team.Blue, x: 2500, y: 1000, yaw: Math.PI / 2 });
  setCar(state, 1, { team: Team.Red, x: -3000, y: 4500, yaw: -Math.PI / 2 });
  setCar(state, 2, { team: Team.Red, x: 300, y: -800, yaw: -Math.PI / 2 });
  const b = new Bot({ team: Team.Blue, difficulty: 'hard' });
  const out = emptyControls();
  for (let i = 0; i < 30; i++) b.think(state, 0, 1, out);
  assert.equal(b.mode, 'defend');
  assertFiniteControls(out, 'multi-opponent');
  // demolished opponents do not count: with the near one demoed the bot goes for the ball
  state.buf[state.carOffset(2) + C_IS_DEMOED] = 1;
  const b2 = new Bot({ team: Team.Blue, difficulty: 'hard' });
  for (let i = 0; i < 30; i++) b2.think(state, 0, -1, out);
  assert.equal(b2.mode, 'attack');
  assertFiniteControls(out, 'multi-opponent demoed');
});

test('bump avoidance: hops when a supersonic opponent is about to ram it', () => {
  const state = makeState(2);
  setBall(state, 0, 3000);
  setCar(state, 0, { team: Team.Blue, x: 0, y: 0, yaw: Math.PI / 2, vx: 0, vy: 400 });
  // opponent 500 uu behind, charging at 2250 uu/s straight at us
  setCar(state, 1, { team: Team.Red, x: 0, y: -500, yaw: Math.PI / 2, vx: 0, vy: 2250 });
  const b = new Bot({ team: Team.Blue, difficulty: 'hard' });
  const out = emptyControls();
  let jumped = false;
  for (let i = 0; i < 4 && !jumped; i++) {
    b.think(state, 0, 1, out);
    jumped = out.jump;
  }
  assert.ok(jumped, 'jumps to dodge the demo');
  // the same opponent driving away does not trigger it
  setCar(state, 1, { team: Team.Red, x: 0, y: -500, yaw: -Math.PI / 2, vx: 0, vy: -2250 });
  const b2 = new Bot({ team: Team.Blue, difficulty: 'hard' });
  for (let i = 0; i < 4; i++) {
    b2.think(state, 0, 1, out);
    assert.ok(!out.jump, 'no jump for an opponent driving away');
  }
});

test('never outputs NaN across random states and all difficulties', () => {
  const rng = new m.Rng(7);
  const out = emptyControls();
  for (const difficulty of ['easy', 'medium', 'hard']) {
    const state = makeState();
    const b = new Bot({ team: Team.Red, difficulty, seed: 3 });
    for (let k = 0; k < 400; k++) {
      if (k % 7 === 0) {
        setBall(state, rng.range(-4000, 4000), rng.range(-5000, 5000), rng.range(93, 1900), rng.range(-2000, 2000), rng.range(-2000, 2000), rng.range(-1000, 1000));
        const air = rng.chance(0.3);
        setCar(state, 1, {
          team: Team.Red, x: rng.range(-4000, 4000), y: rng.range(-5000, 5000), z: air ? rng.range(100, 1500) : 17,
          yaw: rng.range(-Math.PI, Math.PI), vx: rng.range(-2300, 2300), vy: rng.range(-2300, 2300), vz: air ? rng.range(-500, 500) : 0,
          boost: rng.range(0, 100), onGround: air ? 0 : 1,
        });
        if (air && rng.chance(0.5)) {
          const o = state.carOffset(1);
          for (let i = 0; i < 9; i++) state.buf[o + C_ROT + i] = rng.range(-1, 1); // garbage rotation
          state.buf[o + C_IS_FLIPPING] = rng.chance(0.5) ? 1 : 0;
          state.buf[o + C_ANG_VEL] = rng.range(-5, 5); state.buf[o + C_ANG_VEL + 1] = rng.range(-5, 5); state.buf[o + C_ANG_VEL + 2] = rng.range(-5, 5);
        }
        setCar(state, 0, { team: Team.Blue, x: rng.range(-4000, 4000), y: rng.range(-5000, 5000), yaw: rng.range(-Math.PI, Math.PI) });
        for (let i = 0; i < NUM_BOOST_PADS; i++) state.buf[PADS_OFFSET + i * PAD_STRIDE + P_IS_ACTIVE] = rng.chance(0.7) ? 1 : 0;
      }
      b.think(state, 1, k % 50 === 0 ? -1 : 0, out);
      assertFiniteControls(out, `${difficulty} #${k}`);
    }
    // degenerate buffers: all zeros, no opponent, invalid slot
    const blank = makeState(0);
    b.think(blank, 0, -1, out);
    assertFiniteControls(out, `${difficulty} blank`);
    b.think(blank, -1, -1, out);
    assertFiniteControls(out, `${difficulty} invalid slot`);
  }
});

test('kinematic drive: reaches a stationary ball from midfield within 6 s', () => {
  // Bicycle model: yaw rate = steer * curvature(speed) * speed; accel from the driving model.
  const state = makeState();
  setBall(state, 600, 1200);
  setCar(state, 1, { team: Team.Red, x: 0, y: 4800, yaw: -Math.PI / 2 });
  let x = -2000, y = -3200, yaw = 0, speed = 0;
  const o = setCar(state, 0, { team: Team.Blue, x, y, yaw, boost: 100 });
  const b = new Bot({ team: Team.Blue, difficulty: 'hard' });
  const out = emptyControls();
  let reached = false;
  for (let k = 0; k < 6 * 120 && !reached; k++) {
    b.think(state, 0, 1, out);
    assertFiniteControls(out, `kin #${k}`);
    const a = out.throttle > 0 ? m.groundAccel(speed, out.boost) * out.throttle : out.throttle < 0 ? -1200 : -300;
    speed = m.clamp(speed + a * TICK_DT, 0, out.boost ? 2300 : Math.max(1410, speed - 50 * TICK_DT));
    yaw += out.steer * m.curvatureAt(speed) * speed * TICK_DT * (out.handbrake ? 1.6 : 1);
    x += Math.cos(yaw) * speed * TICK_DT;
    y += Math.sin(yaw) * speed * TICK_DT;
    setCar(state, 0, { team: Team.Blue, x, y, yaw, vx: Math.cos(yaw) * speed, vy: Math.sin(yaw) * speed, boost: state.buf[o + C_BOOST] - (out.boost ? 33.3 * TICK_DT : 0) });
    if (m.dist2D(x, y, 600, 1200) < 300) reached = true;
  }
  assert.ok(reached, `car ended at (${x.toFixed(0)}, ${y.toFixed(0)}) without reaching the ball`);
});

test('slow ball close by: drives THROUGH it (target = the ball, full throttle, no reverse) even with the ball behind', () => {
  // Red attacks toward -y. Ball resting 300 uu behind a car facing +y: the hit point lies
  // between the car and the ball, so the old geometry targeted a point a few uu away and the
  // reverse rule (target behind, < 600) backed the car off every time it passed it (dead-ball dither).
  const state = makeState();
  setBall(state, 0, -300);
  setCar(state, 0, { team: Team.Blue, x: 0, y: -4800, yaw: Math.PI / 2 });
  setCar(state, 1, { team: Team.Red, x: 0, y: 0, yaw: Math.PI / 2, boost: 100 });
  const b = new Bot({ team: Team.Red, difficulty: 'hard' });
  const out = emptyControls();
  for (let k = 0; k < 8; k++) {
    b.think(state, 1, 0, out);
    assertFiniteControls(out, `through #${k}`);
  }
  assert.equal(b.mode, 'attack');
  assert.ok(m.dist2D(b.target[0], b.target[1], 0, -300) < 1, `target is the ball itself (${b.target[0]}, ${b.target[1]})`);
  assert.ok(out.throttle > 0.9, `full forward throttle, never reverse (${out.throttle})`);
  assert.equal(Math.abs(out.steer), 1, 'tight turn toward the ball');
  assert.ok(!b.ballStalled, 'no stall yet');
  // A ball rolling fast through the same spot is not driven at blindly: the prediction geometry applies.
  setBall(state, 0, -300, 93.15, 1200, 0, 0);
  b.reset();
  for (let k = 0; k < 8; k++) b.think(state, 1, 0, out);
  assert.ok(m.dist2D(b.target[0], b.target[1], 0, -300) > 100, `fast ball: targets the intercept, not the ball (${b.target[0]}, ${b.target[1]})`);
});

test('near-ball stall: 60 ticks within 450 uu of a low ball without a touch -> target snaps to the ball', () => {
  // Ball 400 uu ahead rolling sideways at 600 uu/s (too fast for the drive-through rule): the
  // target is the intercept's hit point until the stall detector (C_BALL_HIT_TICK unchanged) fires.
  // The car rolls at 300 uu/s so the wedge (wall-stall) detector, which needs < 150 uu/s, stays out.
  const state = makeState();
  setBall(state, 0, -400, 93.15, 600, 0, 0);
  setCar(state, 0, { team: Team.Blue, x: 0, y: -4800, yaw: Math.PI / 2 });
  setCar(state, 1, { team: Team.Red, x: 0, y: 0, yaw: -Math.PI / 2, vy: -300, boost: 100 });
  const b = new Bot({ team: Team.Red, difficulty: 'hard' });
  const out = emptyControls();
  b.think(state, 1, 0, out);
  b.think(state, 1, 0, out);
  assert.equal(b.mode, 'attack');
  assert.ok(m.dist2D(b.target[0], b.target[1], 0, -400) > 100, `before the stall: hit point of the intercept (${b.target[0]}, ${b.target[1]})`);
  assert.ok(!b.ballStalled);
  for (let k = 0; k < 120; k++) {
    b.think(state, 1, 0, out);
    assertFiniteControls(out, `stall #${k}`);
  }
  assert.ok(b.ballStalled, 'stalled after 60+ ticks near the ball without a touch');
  assert.ok(m.dist2D(b.target[0], b.target[1], 0, -400) < 5, `target converged on the ball (${b.target[0]}, ${b.target[1]})`);
  assert.ok(out.throttle > 0.9, `drives at it (${out.throttle})`);
  // a touch (hit tick changes) clears the detector
  state.buf[state.carOffset(1) + types.C_BALL_HIT_TICK] = 7;
  b.think(state, 1, 0, out);
  assert.ok(!b.ballStalled, 'touch clears the stall');
});

test('air stuck: airborne without moving for 60 ticks (balanced on the nose) -> rocking roll / pitch / yaw with throttle', () => {
  // Nose straight up at the centre, no wheel contact, no speed, no boost: the air PD alone holds a
  // constant torque into the wedge (seen for 66 s after a head-on kickoff flip in 1v1).
  const state = makeState();
  setBall(state, 2500, -3000);
  setCar(state, 0, { team: Team.Blue, x: -3000, y: -4000, yaw: Math.PI / 2 });
  setCar(state, 1, { team: Team.Red, x: -110, y: -6, z: 45, onGround: 0, boost: 0, fwd: [0, 0, 1], right: [0, 1, 0], up: [-1, 0, 0] });
  const b = new Bot({ team: Team.Red, difficulty: 'hard' });
  const out = emptyControls();
  const seen = new Set();
  for (let k = 0; k < 200; k++) {
    b.think(state, 1, 0, out);
    assertFiniteControls(out, `air stuck #${k}`);
    if (k < 60) continue;
    assert.equal(out.throttle, 1, `tick ${k}: throttle on for the landing`);
    assert.ok(!out.jump && !out.handbrake);
    if (out.roll === 1) seen.add('roll+');
    if (out.roll === -1) seen.add('roll-');
    if (out.pitch === -1 && out.yaw === 1) seen.add('pitchyaw');
    if (out.pitch === 1 && out.yaw === -1) seen.add('pitchyaw-');
  }
  assert.deepEqual([...seen].sort(), ['pitchyaw', 'pitchyaw-', 'roll+', 'roll-'], `rocks through all four phases (${[...seen]})`);
  // moving again (a real flight): the reflex is off and the normal recover controller steers
  setCar(state, 1, { team: Team.Red, x: 0, y: 0, z: 400, onGround: 0, vx: 900, vy: 0, vz: -200, boost: 0 });
  for (let k = 0; k < 4; k++) b.think(state, 1, 0, out);
  assert.ok(Math.abs(out.roll) < 1 || Math.abs(out.pitch) < 1, 'no rocking pattern while flying');
});

test('difficulty table and setDifficulty', () => {
  assert.ok(DIFFICULTY_PARAMS.easy.throttleMax < 1 && !DIFFICULTY_PARAMS.easy.useBoost && !DIFFICULTY_PARAMS.easy.aerials);
  assert.ok(DIFFICULTY_PARAMS.medium.thinkEvery >= 6);
  assert.ok(DIFFICULTY_PARAMS.hard.aerials);
  const b = new Bot({ team: Team.Blue, difficulty: 'easy' });
  assert.equal(b.difficulty, 'easy');
  b.setDifficulty('hard');
  assert.equal(b.difficulty, 'hard');
});

test('prediction age: predTick ADDS to the entry index (a 3-tick-old buffer reads entry n+3)', () => {
  const state = makeState();
  setBall(state, 100, 200, 93, 500, 0, 0); // entry i = x at (i + 1) ticks after the refresh
  state.buf[0] = 10; // tickCount
  const out = new Float32Array(6);
  state.predTick = 10; // fresh
  predictBallAt(state, 1 / 120, out);
  assert.ok(Math.abs(out[0] - (100 + 500 * TICK_DT)) < 1e-3, `fresh entry 0: ${out[0]}`);
  state.predTick = 7; // refreshed 3 ticks ago: "next tick" is entry 3
  predictBallAt(state, 1 / 120, out);
  assert.ok(Math.abs(out[0] - (100 + 500 * 4 * TICK_DT)) < 1e-3, `aged entry: ${out[0]}`);
  predictBallAt(state, 0, out); // t <= 0 is always the live state
  assert.equal(out[0], 100);
  predictBallAt(state, 100, out); // beyond the horizon still clamps to the last entry
  assert.ok(Math.abs(out[0] - (100 + 500 * BALL_PRED_TICKS * TICK_DT)) < 1e-2);
  // firstReachable reports the time of the chosen entry and its aged position.
  const carPos = m.vec3(100, -800, 17), carVel = m.vec3(0, 0, 0), carFwd = m.vec3(0, 1, 0);
  const t = firstReachable(state, carPos, carVel, carFwd, 0, out);
  assert.ok(t > 0, 'reachable');
  const expectedX = 100 + 500 * (t + 3 * TICK_DT);
  assert.ok(Math.abs(out[0] - expectedX) < 1e-2, `hit point x ${out[0]} vs ${expectedX} (t=${t})`);
  delete state.predTick; // views without predTick are treated as fresh
  predictBallAt(state, 1 / 120, out);
  assert.ok(Math.abs(out[0] - (100 + 500 * TICK_DT)) < 1e-3);
});

test('stall: throttle held without moving -> reverse with mirrored steer after 30 ticks, then resume', () => {
  // Nose against the +x side wall, target far behind-left (no reverse rule: too far), the fake
  // state never moves the car, so the stall detector is the only thing that can change the output.
  const state = makeState();
  setBall(state, 2000, -2000);
  setCar(state, 0, { team: Team.Blue, x: -3000, y: -4000, yaw: Math.PI / 2 });
  setCar(state, 1, { team: Team.Red, x: 4079, y: 0, yaw: 0, boost: 100 }); // full boost: no pad seeking (the big pad behind the car is within the reverse rule's range)
  const b = new Bot({ team: Team.Red, difficulty: 'hard' });
  const out = emptyControls();
  const thr = [];
  const steer = [];
  for (let k = 0; k < 120; k++) {
    b.think(state, 1, 0, out);
    assertFiniteControls(out, `stall #${k}`);
    thr.push(out.throttle);
    steer.push(out.steer);
  }
  for (let k = 0; k < 29; k++) assert.ok(thr[k] > 0.3, `tick ${k}: still pushing (${thr[k]})`);
  const steerBefore = Math.sign(steer[10]);
  assert.notEqual(steerBefore, 0);
  for (let k = 29; k < 74; k++) {
    assert.ok(thr[k] < 0, `tick ${k}: unstick reverses (${thr[k]})`);
    assert.equal(Math.sign(steer[k]), -steerBefore, `tick ${k}: steer mirrored`);
    assert.equal(out.boost, false);
  }
  assert.ok(thr[74] > 0.3 && thr[90] > 0.3, 'back to driving after the unstick phase');
});

test('wall: 3+ wheels on a wall with the ball far -> steer toward world down, full throttle, no boost', () => {
  const state = makeState();
  setBall(state, -2000, 2000);
  setCar(state, 0, { team: Team.Blue, x: -3000, y: -4000, yaw: Math.PI / 2 });
  const b = new Bot({ team: Team.Red, difficulty: 'hard' });
  const out = emptyControls();
  // Nose straight up the +x wall: up = (-1,0,0), fwd = (0,0,1), right = up x fwd = (0,1,0).
  setCar(state, 1, { team: Team.Red, x: 4079, y: 0, z: 700, vx: 0, vy: 0, vz: 1000, boost: 50, fwd: [0, 0, 1], right: [0, 1, 0], up: [-1, 0, 0] });
  let flips = 0;
  let prev = 0;
  for (let k = 0; k < 100; k++) {
    b.think(state, 1, 0, out);
    assertFiniteControls(out, `wall-up #${k}`);
    assert.equal(out.throttle, 1, `tick ${k}: full throttle down the wall`);
    assert.equal(out.boost, false);
    assert.equal(out.handbrake, false);
    assert.equal(Math.abs(out.steer), 1, `tick ${k}: down is straight behind -> full lock`);
    if (k > 0 && Math.sign(out.throttle) !== Math.sign(prev)) flips++;
    prev = out.throttle;
  }
  assert.equal(flips, 0);
  // Nose horizontal along +y on the +x wall: right = (0,0,-1) points down -> steer right (+1).
  setCar(state, 1, { team: Team.Red, x: 4079, y: 0, z: 900, vx: 0, vy: 800, vz: 0, boost: 50, fwd: [0, 1, 0], right: [0, 0, -1], up: [-1, 0, 0] });
  b.think(state, 1, 0, out);
  assert.equal(out.steer, 1, 'down is to the right');
  assert.equal(out.throttle, 1);
  // Mirror: nose along -y, right = (0,0,1) points up -> steer left (-1).
  setCar(state, 1, { team: Team.Red, x: 4079, y: 0, z: 900, vx: 0, vy: -800, vz: 0, boost: 50, fwd: [0, -1, 0], right: [0, 0, 1], up: [-1, 0, 0] });
  b.think(state, 1, 0, out);
  assert.equal(out.steer, -1, 'down is to the left');
  // Ball right next to the car on the wall: normal play, no forced descent.
  setBall(state, 3900, 300, 400);
  setCar(state, 1, { team: Team.Red, x: 4079, y: 0, z: 400, vx: 0, vy: 0, vz: 0, boost: 50, fwd: [0, 1, 0], right: [0, 0, -1], up: [-1, 0, 0] });
  b.think(state, 1, 0, out);
  assertFiniteControls(out, 'wall ball near');
});
