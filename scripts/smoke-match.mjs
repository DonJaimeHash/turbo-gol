// Headless bots-vs-bots match:  node scripts/smoke-match.mjs [mode] [difficulty] [ticks]
//   mode: 1v1 | 2v2 | 3v3 (default 3v3), difficulty: easy | medium | hard (default hard),
//   ticks: default 6000 (50 s of game time).
// Loads the wasm + the analytic arena, adds the cars of `mode` the way main.ts does (blue first,
// then red, player slot 0 is a bot here too), drives both teams with a BotTeam each, resets to
// kickoff after every goal and prints ball touches per team, goals, car-car bumps, how long the
// ball sat still ("stuck"), the longest stretch without a touch and the sim throughput. Exits
// non-zero when the ball barely moves, when any car / the ball leaves the arena, or when the
// ball sits still for too long (bots parked on each other).
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
const { BotTeam } = await import('../src/ai/Team.ts');
const { MODES, ARENA } = await import('../src/sim/constants.ts');
const T = await import('../src/sim/types.ts');

const mode = process.argv[2] ?? '3v3';
const difficulty = process.argv[3] ?? 'hard';
const totalTicks = Number(process.argv[4] ?? 6000);
if (!(mode in MODES)) {
  console.error(`unknown mode "${mode}" (expected ${Object.keys(MODES).join(' | ')})`);
  process.exit(2);
}
if (!['easy', 'medium', 'hard'].includes(difficulty)) {
  console.error(`unknown difficulty "${difficulty}" (expected easy | medium | hard)`);
  process.exit(2);
}
const perTeam = MODES[mode];
const REPORT_EVERY = 1200;
const PRED_EVERY = 4;
/** Ball slower than this (uu/s) counts as "still". */
const STILL_SPEED = 60;
/** A still stretch at least this long (ticks) counts as stuck (kickoff waits excluded). */
const STUCK_MIN_TICKS = 120;
/** Fail when one stuck stretch lasts longer than this (ticks). */
const STUCK_FAIL_TICKS = 10 * T.TICK_RATE;
/** Ticks the ball is left in the net after a goal before the kickoff reset (the goal pause). */
const GOAL_PAUSE_TICKS = 30;
/** A goal within this many ticks of a touch by the conceding team is an own goal (a clear / contact driven into the own net). */
const OWN_GOAL_TICKS = 60;
/** Fail above this many own goals: 1 per 150 s of play, at least 1 (the short default run tolerates one). */
const OWN_GOAL_MAX = Math.max(1, Math.floor(totalTicks / (150 * T.TICK_RATE)));

const t0 = performance.now();
const sim = await RocketSim.load();
const mesh = buildArenaMesh();
sim.initArena(mesh.physics);
sim.createArena(T.TICK_RATE);
// Same creation order as main.ts / Game.addRoster: blue cars first, then red.
const ids = [];
for (let i = 0; i < perTeam; i++) ids.push(sim.addCar(T.Team.Blue, T.CarPreset.Standard));
for (let i = 0; i < perTeam; i++) ids.push(sim.addCar(T.Team.Red, T.CarPreset.Standard));
let kickoffSeed = 0;
sim.resetKickoff(kickoffSeed++);
sim.sync();

const slotBuf = new Int32Array(T.MAX_CARS);
const nBlue = sim.slotsOfTeam(T.Team.Blue, slotBuf);
const blueSlots = Array.from(slotBuf.subarray(0, nBlue));
const nRed = sim.slotsOfTeam(T.Team.Red, slotBuf);
const redSlots = Array.from(slotBuf.subarray(0, nRed));
const blue = new BotTeam({ team: T.Team.Blue, difficulty, seed: 777 });
const red = new BotTeam({ team: T.Team.Red, difficulty, seed: 7 });
blue.setSlots(blueSlots);
red.setSlots(redSlots);
const blueOuts = blueSlots.map(() => T.emptyControls());
const redOuts = redSlots.map(() => T.emptyControls());
console.log(`RocketSim ${sim.version}, arena ${mesh.physics.vertices.length / 3} verts / ${mesh.physics.indices.length / 3} tris, setup ${(performance.now() - t0).toFixed(0)} ms`);
console.log(`${mode} ${difficulty}: blue slots [${blueSlots}] vs red slots [${redSlots}], ${totalTicks} ticks (${(totalTicks / T.TICK_RATE).toFixed(0)} s)`);

const goals = [];
const touches = [[], []]; // per team
const bumps = { total: 0, demos: 0 };
let lastTouch = null;
sim.events.onGoal = (team) => {
  // last toucher attribution: the conceding team touched it last, just before it went in -> own goal
  const own = lastTouch !== null && lastTouch.team !== team && sim.tickCount - lastTouch.tick <= OWN_GOAL_TICKS;
  goals.push({ team, tick: sim.tickCount, own, sinceTouch: lastTouch === null ? -1 : sim.tickCount - lastTouch.tick });
};
sim.events.onBallHit = (carId, relSpeed) => {
  const tick = sim.tickCount;
  if (lastTouch !== null && lastTouch.carId === carId && tick - lastTouch.tick <= 30) {
    lastTouch.tick = tick;
    return;
  }
  const team = sim.teamOf(sim.slotOf(carId));
  lastTouch = { carId, team, relSpeed, tick };
  touches[team].push(lastTouch);
};
sim.events.onBump = (_bumper, _victim, isDemo) => {
  bumps.total++;
  if (isDemo) bumps.demos++;
};

const buf = sim.buf;
const ball = () => [buf[T.BALL_OFFSET + T.B_POS], buf[T.BALL_OFFSET + T.B_POS + 1], buf[T.BALL_OFFSET + T.B_POS + 2]];
const fmt = (v) => `(${v.map((x) => x.toFixed(0)).join(', ')})`;
const teamName = (t) => (t === T.Team.Blue ? 'blue' : 'red');
const roles = (team) => {
  const r = [];
  for (let i = 0; i < team.size; i++) r.push(team.roleAt(i)[0]);
  return r.join('');
};
const insideArena = (x, y, z) => Math.abs(x) <= ARENA.extentX + 50 && Math.abs(y) <= ARENA.extentY + ARENA.goalDepth + 50 && z >= -10 && z <= ARENA.height + 50;

let maxBallDist = 0;
let stillRun = 0; // consecutive still ticks (outside kickoff waits)
let stuckTicks = 0; // sum of still stretches >= STUCK_MIN_TICKS
let longestStuck = 0;
let lastTouchTick = 0;
let longestNoTouch = 0;
let goalPauseLeft = 0;
let outOfArena = null;
const score = [0, 0];

const start = performance.now();
for (let tick = 1; tick <= totalTicks; tick++) {
  if (goalPauseLeft > 0) {
    // Goal pause: nobody drives; then everything back to kickoff like Match.kickoffReset does.
    if (--goalPauseLeft === 0) {
      sim.resetKickoff(kickoffSeed++);
      sim.sync();
      blue.reset();
      red.reset();
      stillRun = 0;
      lastTouchTick = sim.tickCount;
    }
    sim.step(1);
    sim.sync();
    continue;
  }
  const age = sim.tickCount - sim.predTick;
  if (age >= PRED_EVERY || age < 0) sim.updateBallPrediction();
  blue.think(sim, blueOuts);
  red.think(sim, redOuts);
  for (let i = 0; i < blueSlots.length; i++) sim.setControls(sim.carIdOf(blueSlots[i]), blueOuts[i]);
  for (let i = 0; i < redSlots.length; i++) sim.setControls(sim.carIdOf(redSlots[i]), redOuts[i]);
  const goalsBefore = goals.length;
  sim.step(1);
  sim.sync();

  const b = ball();
  const d = Math.hypot(b[0], b[1]);
  if (d > maxBallDist) maxBallDist = d;
  const speed = Math.hypot(buf[T.BALL_OFFSET + T.B_VEL], buf[T.BALL_OFFSET + T.B_VEL + 1], buf[T.BALL_OFFSET + T.B_VEL + 2]);
  const atKickoff = d < 5 && speed < 1; // the ball waiting at the centre is not "stuck"
  if (speed < STILL_SPEED && !atKickoff) {
    stillRun++;
  } else {
    if (stillRun >= STUCK_MIN_TICKS) stuckTicks += stillRun;
    if (stillRun > longestStuck) longestStuck = stillRun;
    stillRun = 0;
  }
  if (lastTouch !== null && lastTouch.tick > lastTouchTick) {
    const gap = lastTouch.tick - lastTouchTick;
    if (gap > longestNoTouch) longestNoTouch = gap;
    lastTouchTick = lastTouch.tick;
  }
  if (outOfArena === null) {
    if (!insideArena(b[0], b[1], b[2])) outOfArena = `ball at ${fmt(b)} (tick ${tick})`;
    for (let s = 0; s < sim.numCars && outOfArena === null; s++) {
      const o = sim.carOffset(s);
      const x = buf[o + T.C_POS];
      const y = buf[o + T.C_POS + 1];
      const z = buf[o + T.C_POS + 2];
      if (!insideArena(x, y, z)) outOfArena = `car slot ${s} at ${fmt([x, y, z])} (tick ${tick})`;
    }
  }
  if (goals.length > goalsBefore) {
    const g = goals[goals.length - 1];
    score[g.team]++;
    const tag = g.own ? ` OWN GOAL by ${teamName(1 - g.team)}, ${g.sinceTouch} ticks after its touch` : '';
    console.log(`  tick ${String(tick).padStart(5)}: GOAL for ${teamName(g.team)} (${score[0]}-${score[1]}, ball ${fmt(b)})${tag}`);
    goalPauseLeft = GOAL_PAUSE_TICKS;
  }
  if (tick % REPORT_EVERY === 0) {
    console.log(
      `  tick ${String(tick).padStart(5)}: ball ${fmt(b)} ${speed.toFixed(0)} uu/s  roles blue=${roles(blue)} red=${roles(red)}  touches ${touches[0].length}/${touches[1].length}  score ${score[0]}-${score[1]}`,
    );
  }
}
if (stillRun >= STUCK_MIN_TICKS) stuckTicks += stillRun;
if (stillRun > longestStuck) longestStuck = stillRun;
const tailGap = sim.tickCount - lastTouchTick;
if (tailGap > longestNoTouch) longestNoTouch = tailGap;

const elapsed = performance.now() - start;
const sec = (ticks) => (ticks / T.TICK_RATE).toFixed(1);
console.log(`${totalTicks} ticks in ${elapsed.toFixed(0)} ms (${((totalTicks / elapsed) * 1000).toFixed(0)} ticks/s, ${((elapsed * 1000) / totalTicks).toFixed(0)} us/tick)`);
const ownGoals = goals.filter((g) => g.own).length;
console.log(`ball touches: ${touches[0].length} blue / ${touches[1].length} red, goals: ${score[0]} blue / ${score[1]} red (${ownGoals} own, i.e. within ${OWN_GOAL_TICKS} ticks of the conceding team's touch), bumps: ${bumps.total} (${bumps.demos} demos)`);
console.log(`stuck time: ${sec(stuckTicks)} s (ball < ${STILL_SPEED} uu/s for >= ${sec(STUCK_MIN_TICKS)} s, kickoff waits excluded), longest still stretch ${sec(longestStuck)} s, longest gap without a touch ${sec(longestNoTouch)} s`);

let failed = false;
if (ownGoals > OWN_GOAL_MAX) {
  console.error(`FAIL: ${ownGoals} own goals (more than ${OWN_GOAL_MAX} allowed for ${sec(totalTicks)} s)`);
  failed = true;
}
if (maxBallDist < 500) {
  console.error(`FAIL: the ball barely moved (max distance from centre ${maxBallDist.toFixed(0)} uu)`);
  failed = true;
}
if (outOfArena !== null) {
  console.error(`FAIL: left the arena: ${outOfArena}`);
  failed = true;
}
if (longestStuck > STUCK_FAIL_TICKS) {
  console.error(`FAIL: the ball sat still for ${sec(longestStuck)} s`);
  failed = true;
}
if (failed) process.exit(1);
console.log(`OK: ball moved up to ${maxBallDist.toFixed(0)} uu from the centre`);
