// The corners of the experimental physics table: for every extreme preset and 3 seeds, a 60 s 3v3
// bot match (bots with the preset's profile, kickoff after each goal) must keep a finite state, the
// ball and every car inside the field or a goal chamber on every tick (nothing tunnels through the
// thin goal and corner mesh), the wasm alive, and cost about what stock costs per tick. Shots at
// the ball's top speed (the table's maximum and the wasm's hard limit) check the tunnelling bound.
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
const R = await import('../src/game/physicsRules.ts');
const L = await import('../src/sim/mutatorLayout.ts');

const sim = await RocketSim.load();
sim.initArena(buildArenaMesh().physics);

const wasmFields = R.PHYSICS_FIELDS.filter((f) => f.scope === 'all');
const allAt = (pick) => Object.fromEntries(wasmFields.map((f) => [f.key, pick(f)]));

const CORNERS = {
  'all minimums': allAt((f) => R.fieldValues(f)[0]),
  'all maximums': allAt((f) => R.fieldValues(f).at(-1)),
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
  for (const p of R.BUILT_IN_PRESETS) {
    const s = match(p.values, 4, TICKS / 2);
    costs.push({ name: p.id, us: s.us });
    console.log(`built-in ${p.id}: ${s.goals} goals, ${s.touches} touches, ${s.bumps} bumps (${s.demos} demos), ${s.us.toFixed(0)} us/tick`);
  }
});

/**
 * Shots at the ball's top speed into the thin parts of the mesh: the posts and crossbar, the back
 * wall beside the goal, the goal's back, side nets and roof, the rounded corners, the side walls,
 * the ceiling and the floor. The bot matches above never get the ball near its cap (under 5000
 * uu/s), so this is what checks the tunnelling bound of the table's maximum (7800 uu/s, 65 uu per
 * tick) and of the wasm's hard limit (8500, 71 uu per tick) that a modified client could set.
 */
function topSpeedShots(cap) {
  const m = M.toMutators({ ballMaxSpeed: 130, ballBounce: 150, ballDrag: 0, gravity: 30 });
  m[L.M_BALL_MAX_SPEED] = cap;
  sim.createArena(T.TICK_RATE, m);
  sim.events.onGoal = sim.events.onBump = sim.events.onBallHit = undefined;
  const Y = ARENA.extentY;
  const targets = [];
  for (const sy of [1, -1]) {
    for (const x of [-1100, -1000, 1000, 1050, 1100, 1200, 2500]) for (const z of [100, 300, 720, 760, 1500]) targets.push([x, sy * Y, z]);
    for (const x of [-900, 0, 900]) targets.push([x, sy * (Y + ARENA.goalDepth), 300]);
    for (const y of [Y + 200, Y + 600, Y + 900]) targets.push([1000, sy * y, 300], [-1000, sy * y, 300], [0, sy * y, ARENA.goalHeight]);
    for (const a of [0.2, 0.5, 0.8]) {
      const cx = ARENA.cornerCentreX + ARENA.cornerRadius * Math.cos((a * Math.PI) / 2);
      const cy = ARENA.cornerCentreY + ARENA.cornerRadius * Math.sin((a * Math.PI) / 2);
      for (const z of [200, 1800]) targets.push([cx, sy * cy, z], [-cx, sy * cy, z]);
    }
  }
  for (const x of [-ARENA.extentX, ARENA.extentX]) for (const y of [-3000, 0, 3000]) targets.push([x, y, 1000]);
  for (const x of [-2000, 2000]) targets.push([x, 0, ARENA.height], [x, 2000, 0]);
  const starts = [[0, 0, 1000], [2000, 3000, 400], [3000, 0, 1500], [0, 4000, 800], [0, -5000, 600]];
  let shots = 0;
  let worst = 0;
  for (const s of starts) {
    for (const t of targets) {
      const d = [t[0] - s[0], t[1] - s[1], t[2] - s[2]];
      const len = Math.hypot(d[0], d[1], d[2]);
      if (len < 500) continue;
      shots++;
      sim.setBallState(s, d.map((c) => (c / len) * cap), [0, 0, 0]);
      for (let k = 0; k < 150; k++) {
        sim.step(1);
        sim.sync();
        const x = sim.buf[T.BALL_OFFSET + T.B_POS];
        const y = sim.buf[T.BALL_OFFSET + T.B_POS + 1];
        const z = sim.buf[T.BALL_OFFSET + T.B_POS + 2];
        const where = `cap ${cap}, shot from (${s}) at (${t.map(Math.round)}), tick ${k + 1}: ball at (${[x, y, z].map(Math.round)})`;
        assert.ok(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z), where);
        // A hit on a rounded post can push the centre a few uu past this box approximation for one
        // tick (measured: at most 20); a ball through the mesh keeps going.
        let margin = 0;
        while (margin <= 40 && !inside(x, y, z, margin)) margin += 5;
        assert.ok(margin <= 40, where);
        worst = Math.max(worst, margin);
      }
    }
  }
  return { shots, worst };
}

test('the ball at its top speed (table maximum and wasm hard limit) never tunnels through the posts, nets, corners or walls', () => {
  for (const cap of [Math.fround(7800), L.MUTATOR_HARD_LIMITS[L.M_BALL_MAX_SPEED][1]]) {
    const r = topSpeedShots(cap);
    console.log(`ball at ${cap} uu/s: ${r.shots} shots, its centre at most ${r.worst} uu past the field / chamber box`);
    assert.ok(r.shots > 300);
  }
});

test('cost: a preset match costs about what a stock match costs per tick (no hidden re-simulation)', () => {
  const stock = (match(null, 1, TICKS / 2).us + match(null, 2, TICKS / 2).us) / 2;
  const sorted = costs.map((c) => c.us).sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  const worst = costs.reduce((a, c) => (c.us > a.us ? c : a), { name: '-', us: 0 });
  console.log(`stock ${stock.toFixed(0)} us/tick (sim + 6 bots), presets: median ${median.toFixed(0)}, slowest ${worst.name} ${worst.us.toFixed(0)} us/tick`);
  // A predictor that re-simulated 720 ticks on every refresh would add ~300-500 us per tick to
  // every preset run; timing noise moves single runs, not the median.
  assert.ok(median < stock * 2 + 40, `median preset run ${median.toFixed(0)} us/tick vs stock ${stock.toFixed(0)}`);
});
