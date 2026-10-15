// Headless simulation smoke test:  node scripts/smoke-sim.mjs [difficulty] [ticks]
// Loads the wasm + the analytic arena, adds two cars (slot 0 blue = idle, slot 1 red = Bot),
// runs the bot against the idle car and prints the ball position every 600 ticks, whether a goal
// happened and the sim throughput. Exits non-zero when the bot fails to move the ball.
import { registerHooks } from 'node:module';
import { performance } from 'node:perf_hooks';

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

const difficulty = process.argv[2] ?? 'hard';
const totalTicks = Number(process.argv[3] ?? 3000);
const REPORT_EVERY = 600;
const PRED_EVERY = 4;

const t0 = performance.now();
const sim = await RocketSim.load();
const mesh = buildArenaMesh();
sim.initArena(mesh.physics);
sim.createArena(T.TICK_RATE);
const idleId = sim.addCar(T.Team.Blue, T.CarPreset.Standard);
const botId = sim.addCar(T.Team.Red, T.CarPreset.Standard);
sim.resetKickoff(0);
sim.sync();
const idleSlot = sim.slotOf(idleId);
const botSlot = sim.slotOf(botId);
console.log(`RocketSim ${sim.version}, arena ${mesh.physics.vertices.length / 3} verts / ${mesh.physics.indices.length / 3} tris, setup ${(performance.now() - t0).toFixed(0)} ms`);
console.log(`bot: red slot ${botSlot} (${difficulty}) vs idle blue slot ${idleSlot}, ${totalTicks} ticks`);

const goals = [];
const hits = [];
sim.events.onGoal = (team) => goals.push({ team, tick: sim.tickCount });
sim.events.onBallHit = (carId, relSpeed) => {
  if (hits.length === 0 || hits[hits.length - 1].carId !== carId || sim.tickCount - hits[hits.length - 1].tick > 30) {
    hits.push({ carId, relSpeed, tick: sim.tickCount });
  }
};

const bot = new Bot({ team: T.Team.Red, difficulty, seed: 7 });
const idle = T.emptyControls();
const ctl = T.emptyControls();
const ball = () => [sim.buf[T.BALL_OFFSET + T.B_POS], sim.buf[T.BALL_OFFSET + T.B_POS + 1], sim.buf[T.BALL_OFFSET + T.B_POS + 2]];
const car = (slot) => {
  const o = sim.carOffset(slot);
  return [sim.buf[o + T.C_POS], sim.buf[o + T.C_POS + 1], sim.buf[o + T.C_POS + 2]];
};
const fmt = (v) => `(${v.map((x) => x.toFixed(0)).join(', ')})`;

let maxBallDist = 0;
let goalTick = -1;
const start = performance.now();
for (let tick = 1; tick <= totalTicks; tick++) {
  if (tick % PRED_EVERY === 1) sim.updateBallPrediction();
  bot.think(sim, botSlot, idleSlot, ctl);
  sim.setControls(botId, ctl);
  sim.setControls(idleId, idle);
  sim.step(1);
  sim.sync();
  const b = ball();
  const d = Math.hypot(b[0], b[1]);
  if (d > maxBallDist) maxBallDist = d;
  if (goals.length > 0 && goalTick < 0) {
    goalTick = tick;
    console.log(`  tick ${String(tick).padStart(5)}: GOAL for ${goals[0].team === T.Team.Blue ? 'blue' : 'red'} (ball ${fmt(b)})`);
  }
  if (tick % REPORT_EVERY === 0) {
    const o = sim.carOffset(botSlot);
    const speed = Math.hypot(sim.buf[o + T.C_VEL], sim.buf[o + T.C_VEL + 1], sim.buf[o + T.C_VEL + 2]);
    console.log(
      `  tick ${String(tick).padStart(5)}: ball ${fmt(b)}  bot ${fmt(car(botSlot))} ${speed.toFixed(0)} uu/s boost ${sim.buf[o + T.C_BOOST].toFixed(0)} mode=${bot.mode}  goals=${goals.length}`,
    );
  }
}
const elapsed = performance.now() - start;
console.log(`${totalTicks} ticks in ${elapsed.toFixed(0)} ms (${((totalTicks / elapsed) * 1000).toFixed(0)} ticks/s), ${hits.length} ball touches, ${goals.length} goal(s)`);
if (goals.length > 0) {
  console.log(`first goal at tick ${goalTick} (${(goalTick / T.TICK_RATE).toFixed(1)} s) for ${goals[0].team === T.Team.Blue ? 'blue' : 'red'}`);
} else {
  console.log('no goal within the run (nice-to-have only)');
}
if (maxBallDist < 500) {
  console.error(`FAIL: the ball barely moved (max distance from centre ${maxBallDist.toFixed(0)} uu)`);
  process.exit(1);
}
console.log(`OK: ball moved up to ${maxBallDist.toFixed(0)} uu from the centre`);
