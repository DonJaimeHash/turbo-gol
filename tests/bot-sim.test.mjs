// Bot recovery scenarios against the real physics (wasm + analytic arena):
//   node --test tests/bot-sim.test.mjs      (needs src/sim/wasm/rocketsim.{js,wasm}: npm run build:wasm)
// Each case parks the bot's car in a situation the plain decision tree could not leave (nose into
// the goal netting, wedged on a post, riding a wall) and asserts it gets out quickly and cleanly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (relative && err && err.code === 'ERR_MODULE_NOT_FOUND') {
        if (!/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + '.ts', context);
        if (specifier.endsWith('.js')) return nextResolve(specifier.slice(0, -3) + '.ts', context);
      }
      throw err;
    }
  },
});

const { RocketSim } = await import('../src/sim/RocketSimBridge.ts');
const { buildArenaMesh } = await import('../src/sim/arenaMesh.ts');
const { Bot } = await import('../src/ai/Bot.ts');
const T = await import('../src/sim/types.ts');
const { ARENA } = await import('../src/sim/constants.ts');

const W = ARENA.extentX;
const L = ARENA.extentY;
const GW = ARENA.goalHalfWidth;

const sim = await RocketSim.load();
sim.initArena(buildArenaMesh().physics);

const car = (slot, f) => sim.buf[T.CARS_OFFSET + slot * T.CAR_STRIDE + f];
const carVec = (slot, f) => [car(slot, f), car(slot, f + 1), car(slot, f + 2)];
const fmt = (v) => v.map((x) => x.toFixed(0)).join(',');
const DIFFICULTIES = ['easy', 'medium', 'hard'];

/**
 * Bot (slot 1, red) vs an idle car parked far away. `place(id)` positions the bot's car, then
 * the loop runs like Game.tick (prediction every 4 ticks) until `done(pos, up, onGround)` holds.
 * Returns the tick it happened at (-1 = never) plus throttle sign flips and jump presses.
 */
function run(difficulty, ballPos, place, done, maxTicks) {
  sim.createArena();
  sim.events.onGoal = undefined;
  sim.events.onBump = undefined;
  const idle = sim.addCar(T.Team.Blue);
  const id = sim.addCar(T.Team.Red);
  sim.setCarState(idle, [-2600, -(L - 1200), 17], [Math.PI / 2, 0, 0]);
  sim.setBallState(ballPos);
  place(id);
  sim.sync();
  const bot = new Bot({ team: T.Team.Red, difficulty, seed: 3 });
  const ctrl = T.emptyControls();
  let flips = 0;
  let prevThr = 0;
  let jumps = 0;
  let prevJump = false;
  for (let t = 0; t < maxTicks; t++) {
    if (t % 4 === 0) sim.updateBallPrediction();
    bot.think(sim, 1, 0, ctrl);
    if (Math.abs(ctrl.throttle) > 0.1 && Math.abs(prevThr) > 0.1 && Math.sign(ctrl.throttle) !== Math.sign(prevThr)) flips++;
    prevThr = ctrl.throttle;
    if (ctrl.jump && !prevJump) jumps++;
    prevJump = ctrl.jump;
    sim.setControls(id, ctrl);
    sim.step(1);
    sim.sync();
    const pos = carVec(1, T.C_POS);
    if (done(pos, carVec(1, T.C_ROT + 6), car(1, T.C_IS_ON_GROUND) > 0.5)) return { at: t, flips, jumps, pos };
  }
  return { at: -1, flips, jumps, pos: carVec(1, T.C_POS) };
}

const outOfNet = (p) => Math.abs(p[1]) < L - 320;
const onFloor = (p, up, og) => p[2] < 60 && up[2] > 0.9 && og;

test('net: nose pressed into the side netting (deep in the blue net) with a far target -> out within 3 s', () => {
  const ballAt = [GW + 800, -(L - 1400)]; // a ball out in front of the blue goal, off to the side
  for (const d of DIFFICULTIES) {
    const r = run(d, [ballAt[0], ballAt[1], 93.15], (id) => sim.setCarState(id, [GW - 74, -(L + 630), 17], [0, 0, 0]), outOfNet, 6 * 120);
    console.log(`net [${d}]: out at ${(r.at / 120).toFixed(2)} s, throttle flips ${r.flips}, pos ${fmt(r.pos)}`);
    assert.ok(r.at >= 0 && r.at <= 3 * 120, `${d}: left the net at tick ${r.at}`);
    assert.ok(r.flips <= 3, `${d}: ${r.flips} throttle sign flips (no dithering)`);
  }
});

test('net: at the post line of its own goal facing the netting -> out within 3 s', () => {
  for (const d of DIFFICULTIES) {
    const r = run(d, [0, 2000, 93.15], (id) => sim.setCarState(id, [GW - 74, L - 52, 17], [0, 0, 0]), outOfNet, 6 * 120);
    console.log(`mouth [${d}]: out at ${(r.at / 120).toFixed(2)} s, throttle flips ${r.flips}, pos ${fmt(r.pos)}`);
    assert.ok(r.at >= 0 && r.at <= 3 * 120, `${d}: left the mouth at tick ${r.at}`);
    assert.ok(r.flips <= 3, `${d}: ${r.flips} throttle sign flips`);
  }
});

test('post: wedged nose-up on a goal post (isOnGround flickers) -> out within 4 s', () => {
  for (const d of DIFFICULTIES) {
    const r = run(d, [1000, -2000, 93.15], (id) => sim.setCarState(id, [-(GW - 72), L - 85, 25], [Math.PI / 2, 0.13, 0]), (p) => Math.abs(p[1]) < L - 420, 6 * 120);
    console.log(`post [${d}]: out at ${(r.at / 120).toFixed(2)} s, throttle flips ${r.flips}, pos ${fmt(r.pos)}`);
    assert.ok(r.at >= 0 && r.at <= 4 * 120, `${d}: left the post at tick ${r.at}`);
  }
});

test('wall: riding the +x wall nose-up at z=700, ball far -> on the floor within 3 s, no throttle flips', () => {
  for (const d of DIFFICULTIES) {
    const r = run(
      d,
      [-2000, 2000, 93.15],
      (id) => {
        sim.setCarState(id, [W - 17, 0, 700], [0, Math.PI / 2, 0], [0, 0, 1000]);
        sim.setCarBoost(id, 20);
      },
      onFloor,
      6 * 120,
    );
    console.log(`wall [${d}]: floor at ${(r.at / 120).toFixed(2)} s, throttle flips ${r.flips}, jumps ${r.jumps}, pos ${fmt(r.pos)}`);
    assert.ok(r.at >= 0 && r.at <= 3 * 120, `${d}: reached the floor at tick ${r.at}`);
    assert.equal(r.flips, 0, `${d}: throttle must not toggle on the wall`);
  }
});

test('wall: back wall above the goal, ball mid-field -> on the floor within 3 s', () => {
  for (const d of DIFFICULTIES) {
    const r = run(d, [0, -1000, 93.15], (id) => sim.setCarState(id, [2000, L - 17, 900], [Math.PI / 2, Math.PI / 2, 0], [0, 0, 600]), onFloor, 6 * 120);
    console.log(`back wall [${d}]: floor at ${(r.at / 120).toFixed(2)} s, throttle flips ${r.flips}, pos ${fmt(r.pos)}`);
    assert.ok(r.at >= 0 && r.at <= 3 * 120, `${d}: reached the floor at tick ${r.at}`);
    assert.equal(r.flips, 0);
  }
});

test('wall: high on the wall with the ball on the floor directly below -> comes down within 3 s', () => {
  const r = run('hard', [W - 500, 0, 93.15], (id) => sim.setCarState(id, [W - 17, 0, 450], [Math.PI / 2, 0, -Math.PI / 2]), onFloor, 6 * 120);
  console.log(`wall above ball: floor at ${(r.at / 120).toFixed(2)} s, pos ${fmt(r.pos)}`);
  assert.ok(r.at >= 0 && r.at <= 3 * 120, `reached the floor at tick ${r.at}`);
});
