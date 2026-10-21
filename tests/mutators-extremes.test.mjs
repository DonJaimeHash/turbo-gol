// The corners of the experimental physics table: for every extreme preset and 3 seeds, a 60 s 3v3
// bot match (bots with the preset's profile, kickoff after each goal) must keep a finite state, the
// ball and every car inside the field or a goal chamber on every tick (nothing tunnels through the
// thin goal and corner mesh), the wasm alive, and cost about what stock costs per tick.
//   node --test tests/mutators-extremes.test.mjs      (needs src/sim/wasm/rocketsim.{js,wasm})
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

await import('../scripts/stock-trace.mjs'); // registers the .ts resolve hook
const { RocketSim } = await import('../src/sim/RocketSimBridge.ts');
const { buildArenaMesh } = await import('../src/sim/arenaMesh.ts');
const { BotTeam } = await import('../src/ai/Team.ts');
const { ARENA } = await import('../src/sim/constants.ts');
const T = await import('../src/sim/types.ts');
const M = await import('../src/sim/mutators.ts');

const sim = await RocketSim.load();
sim.initArena(buildArenaMesh().physics);

const wasmFields = M.PHYSICS_FIELDS.filter((f) => f.scope === 'all');
const allAt = (pick) => Object.fromEntries(wasmFields.map((f) => [f.key, pick(f)]));

const CORNERS = {
  'all minimums': allAt((f) => f.min),
  'all maximums': allAt((f) => f.max),
  'fast ball, low gravity': { gravity: 30, ballMaxSpeed: 130, ballHit: 200, ballWeight: 50, ballBounce: 150, ballDrag: 0 },
  'car 2600, bump 300 %, demolition on contact': { carMaxSpeed: 2600, bumpForce: 300, boostPower: 200, boostUse: 0, jumpPower: 150, unlimitedFlips: 1, unlimitedDoubleJumps: 1, demoMode: 1, respawnDelay: 1 },
};

/** Where a centre may be: in the field, or behind a goal line only inside that goal's chamber. */
function inside(x, y, z, margin) {
  if (!(Math.abs(x) <= ARENA.extentX + margin && z >= -margin && z <= ARENA.height + margin)) return false;
  const ay = Math.abs(y);
  if (ay > ARENA.extentY + ARENA.goalDepth + margin) return false;
  if (ay > ARENA.extentY + margin) return Math.abs(x) <= ARENA.goalHalfWidth + margin && z <= ARENA.goalHeight + margin;
  return true;
}

/** A 3v3 bot match; returns stats or throws on the first broken invariant. */
function match(values, seed, ticks) {
  sim.createArena(T.TICK_RATE, values ? M.toMutators(values) : null);
  sim.events.onGoal = sim.events.onBump = sim.events.onBallHit = undefined;
  for (let i = 0; i < 3; i++) sim.addCar(T.Team.Blue);
  for (let i = 0; i < 3; i++) sim.addCar(T.Team.Red);
  let kickoff = seed * 100;
  sim.resetKickoff(kickoff++);
  sim.sync();
  const physics = values ? M.botPhysicsOf(values) : undefined;
  const slotBuf = new Int32Array(T.MAX_CARS);
  const blueSlots = Array.from(slotBuf.subarray(0, sim.slotsOfTeam(T.Team.Blue, slotBuf)));
  const redSlots = Array.from(slotBuf.subarray(0, sim.slotsOfTeam(T.Team.Red, slotBuf)));
  const blue = new BotTeam({ team: T.Team.Blue, difficulty: 'hard', seed: 777 + seed, physics });
  const red = new BotTeam({ team: T.Team.Red, difficulty: 'hard', seed: 7 + seed, physics });
  blue.setSlots(blueSlots);
  red.setSlots(redSlots);
  const bo = blueSlots.map(() => T.emptyControls());
  const ro = redSlots.map(() => T.emptyControls());
  const stats = { goals: 0, bumps: 0, demos: 0, touches: 0, maxBall: 0, maxCar: 0, us: 0 };
  sim.events.onGoal = () => stats.goals++;
  sim.events.onBump = (_a, _b, demo) => {
    stats.bumps++;
    if (demo) stats.demos++;
  };
  sim.events.onBallHit = () => stats.touches++;
  const buf = sim.buf;
  let pause = 0;
  const t0 = performance.now();
  for (let tick = 1; tick <= ticks; tick++) {
    if (pause > 0) {
      if (--pause === 0) {
        sim.resetKickoff(kickoff++);
        sim.sync();
        blue.reset();
        red.reset();
      }
    } else {
      const age = sim.tickCount - sim.predTick;
      if (age >= 4 || age < 0) sim.updateBallPrediction();
      blue.think(sim, bo);
      red.think(sim, ro);
      for (let i = 0; i < blueSlots.length; i++) sim.setControls(sim.carIdOf(blueSlots[i]), bo[i]);
      for (let i = 0; i < redSlots.length; i++) sim.setControls(sim.carIdOf(redSlots[i]), ro[i]);
    }
    const goalsBefore = stats.goals;
    sim.step(1);
    sim.sync();
    if (stats.goals > goalsBefore) pause = 30;
    for (let i = 0; i < T.PADS_OFFSET; i++) {
      if (!Number.isFinite(buf[i])) throw new Error(`tick ${tick}: state float ${i} is ${buf[i]}`);
    }
    const bx = buf[T.BALL_OFFSET + T.B_POS];
    const by = buf[T.BALL_OFFSET + T.B_POS + 1];
    const bz = buf[T.BALL_OFFSET + T.B_POS + 2];
    if (!inside(bx, by, bz, 10)) throw new Error(`tick ${tick}: ball outside the field at (${bx.toFixed(0)}, ${by.toFixed(0)}, ${bz.toFixed(0)})`);
    stats.maxBall = Math.max(stats.maxBall, Math.hypot(buf[T.BALL_OFFSET + T.B_VEL], buf[T.BALL_OFFSET + T.B_VEL + 1], buf[T.BALL_OFFSET + T.B_VEL + 2]));
    for (let s = 0; s < 6; s++) {
      const o = T.CARS_OFFSET + s * T.CAR_STRIDE;
      const x = buf[o + T.C_POS];
      const y = buf[o + T.C_POS + 1];
      const z = buf[o + T.C_POS + 2];
      if (!inside(x, y, z, 60)) throw new Error(`tick ${tick}: car ${s} outside the field at (${x.toFixed(0)}, ${y.toFixed(0)}, ${z.toFixed(0)})`);
      stats.maxCar = Math.max(stats.maxCar, Math.hypot(buf[o + T.C_VEL], buf[o + T.C_VEL + 1], buf[o + T.C_VEL + 2]));
    }
  }
  stats.us = ((performance.now() - t0) * 1000) / ticks;
  assert.notEqual(sim.stateHash(), 0, 'the arena is alive');
  return stats;
}

const TICKS = 60 * T.TICK_RATE;
const costs = [];

for (const [name, values] of Object.entries(CORNERS)) {
  test(`extreme preset "${name}": 3 seeds x 60 s of 3v3 bots stay finite, inside the field, no tunnelling`, () => {
    for (let seed = 1; seed <= 3; seed++) {
      const s = match(values, seed, TICKS);
      costs.push({ name, us: s.us });
      console.log(`${name}, seed ${seed}: ${s.goals} goals, ${s.touches} touches, ${s.bumps} bumps (${s.demos} demos), ball up to ${s.maxBall.toFixed(0)} uu/s, cars up to ${s.maxCar.toFixed(0)} uu/s, ${s.us.toFixed(0)} us/tick`);
      assert.ok(s.touches > 0, 'the bots play the ball');
    }
  });
}

test('built-in presets: 30 s of 3v3 bots each stay finite and inside the field', () => {
  for (const p of M.BUILT_IN_PRESETS) {
    const s = match(p.values, 4, TICKS / 2);
    costs.push({ name: p.id, us: s.us });
    console.log(`built-in ${p.id}: ${s.goals} goals, ${s.touches} touches, ${s.bumps} bumps (${s.demos} demos), ${s.us.toFixed(0)} us/tick`);
  }
});

test('cost: a preset match costs about what a stock match costs per tick (no hidden re-simulation)', () => {
  const stock = Math.min(match(null, 1, TICKS / 2).us, match(null, 2, TICKS / 2).us);
  const worst = costs.reduce((a, c) => (c.us > a.us ? c : a), { name: '-', us: 0 });
  console.log(`stock ${stock.toFixed(0)} us/tick (sim + 6 bots), slowest preset run: ${worst.name} ${worst.us.toFixed(0)} us/tick`);
  // A predictor that re-simulated 720 ticks on every refresh would add ~300-500 us per tick here.
  assert.ok(worst.us < stock * 2.5 + 40, `${worst.name}: ${worst.us.toFixed(0)} us/tick vs stock ${stock.toFixed(0)}`);
});
