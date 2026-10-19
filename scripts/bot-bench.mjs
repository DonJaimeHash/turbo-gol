// Bot tournament: the bots of this working tree (A) against the bots of a git revision (B).
//   node scripts/bot-bench.mjs [--baseline=origin/main] [--modes=1v1,2v2,3v3] [--matches=8]
//                              [--difficulty=hard] [--difficultyB=<same>] [--seconds=180] [--seed=1]
//                              [--tuneA=key=value,...] [--paramsA=difficulty.key=value,...]
//                              [--json=results.json]
// --tuneA / --paramsA override A's TUNING / DIFFICULTY_PARAMS values (numbers or true / false), to
// compare variants of a change without editing the code (scripts/bot-lib.mjs).
// Headless matches on the real physics (wasm + analytic arena), like scripts/smoke-match.mjs:
// kickoff after every goal, ball prediction every 4 ticks. A plays blue in even matches and red in
// odd ones, every match with its own seeds, so both sides and kickoff orders are covered.
// Per mode it prints A's wins / draws / losses, its score with a 95 % interval and the Elo
// difference that implies (with 40 matches equal bots still land anywhere in about 35-65 %: only
// "A better" / "A worse" means something), the think() cost per bot and tick for each side, and
// per team and match: goals, own goals, touches, aerial touches (car in the air, ball above 300 uu),
// shots on target (a touch that sends the ball at the opponent's mouth, ballistic, within 3 s),
// passes (a touch within 3 s of a teammate's), forward touches (% of touches leaving the ball moving
// toward the opponent's goal at > 500 uu/s); plus the share of the match the ball spends above 500 uu.
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { applyOverrides, arg, loadBots, loadSim, scoreSummary } from './bot-lib.mjs';

const baseline = arg('baseline', 'origin/main');
const modes = arg('modes', '1v1,2v2,3v3').split(',');
const matches = Number(arg('matches', '8'));
const diffA = arg('difficulty', 'hard');
const diffB = arg('difficultyB', diffA);
const seconds = Number(arg('seconds', '180'));
const seed0 = Number(arg('seed', '1'));
const jsonOut = arg('json', '');

const A = await loadBots(null);
applyOverrides(A, arg('tuneA', ''), arg('paramsA', ''));
const B = await loadBots(baseline);
const { sim, C, T } = await loadSim();
const { MODES, ARENA } = C;

const PRED_EVERY = 4;
const GOAL_PAUSE_TICKS = 30;
const OWN_GOAL_TICKS = 60;
const PASS_TICKS = 3 * T.TICK_RATE;
const L = ARENA.extentY;
const GRAV = 650;

/** A touch that sends the ball at the mouth of the goal at y = goalY within 3 s (ballistic, no bounces). */
function onTarget(goalY) {
  const o = T.BALL_OFFSET;
  const b = sim.buf;
  const x = b[o + T.B_POS], y = b[o + T.B_POS + 1], z = b[o + T.B_POS + 2];
  const vx = b[o + T.B_VEL], vy = b[o + T.B_VEL + 1], vz = b[o + T.B_VEL + 2];
  if (vy * Math.sign(goalY) <= 50) return false;
  const t = (goalY - y) / vy;
  if (t <= 0 || t > 3) return false;
  const zx = z + vz * t - 0.5 * GRAV * t * t;
  return Math.abs(x + vx * t) < ARENA.goalHalfWidth && zx > 0 && zx < ARENA.goalHeight + 200;
}

const emptyStats = () => ({ goals: 0, own: 0, touches: 0, aerial: 0, shots: 0, passes: 0, forward: 0, thinkMs: 0, botTicks: 0 });

function playMatch(mode, aIsBlue, seed) {
  const perTeam = MODES[mode];
  sim.createArena(T.TICK_RATE);
  for (let i = 0; i < perTeam; i++) sim.addCar(T.Team.Blue, T.CarPreset.Standard);
  for (let i = 0; i < perTeam; i++) sim.addCar(T.Team.Red, T.CarPreset.Standard);
  let kickoffSeed = seed * 31;
  sim.resetKickoff(kickoffSeed++);
  sim.sync();
  const slotBuf = new Int32Array(T.MAX_CARS);
  const slotsOf = (team) => Array.from(slotBuf.subarray(0, sim.slotsOfTeam(team, slotBuf)));
  const blueSlots = slotsOf(T.Team.Blue);
  const redSlots = slotsOf(T.Team.Red);
  const mk = (lib, team, difficulty) => new lib.BotTeam({ team, difficulty, seed: seed * 7919 + (team === T.Team.Blue ? 777 : 7) });
  const blue = aIsBlue ? mk(A, T.Team.Blue, diffA) : mk(B, T.Team.Blue, diffB);
  const red = aIsBlue ? mk(B, T.Team.Red, diffB) : mk(A, T.Team.Red, diffA);
  blue.setSlots(blueSlots);
  red.setSlots(redSlots);
  const blueOuts = blueSlots.map(() => T.emptyControls());
  const redOuts = redSlots.map(() => T.emptyControls());

  const st = [emptyStats(), emptyStats()];
  let highTicks = 0;
  let lastTouch = null;
  let pendingShot = null; // a touch whose ball direction is judged on the next tick
  sim.events.onGoal = (team) => {
    st[team].goals++;
    if (lastTouch !== null && lastTouch.team !== team && sim.tickCount - lastTouch.tick <= OWN_GOAL_TICKS) st[1 - team].own++;
  };
  sim.events.onBallHit = (carId) => {
    const tick = sim.tickCount;
    if (lastTouch !== null && lastTouch.carId === carId && tick - lastTouch.tick <= 30) {
      lastTouch.tick = tick;
      return;
    }
    const slot = sim.slotOf(carId);
    const team = sim.teamOf(slot);
    const s = st[team];
    s.touches++;
    const co = sim.carOffset(slot);
    if (sim.buf[co + T.C_IS_ON_GROUND] < 0.5 && sim.buf[T.BALL_OFFSET + T.B_POS + 2] > 300) s.aerial++;
    if (lastTouch !== null && lastTouch.team === team && lastTouch.carId !== carId && tick - lastTouch.tick <= PASS_TICKS) s.passes++;
    lastTouch = { carId, team, tick };
    pendingShot = { team, tick };
  };
  sim.events.onBump = undefined;

  const total = seconds * T.TICK_RATE;
  let goalPause = 0;
  for (let tick = 1; tick <= total; tick++) {
    if (goalPause > 0) {
      if (--goalPause === 0) {
        sim.resetKickoff(kickoffSeed++);
        sim.sync();
        blue.reset();
        red.reset();
        lastTouch = null;
      }
      sim.step(1);
      sim.sync();
      continue;
    }
    const age = sim.tickCount - sim.predTick;
    if (age >= PRED_EVERY || age < 0) sim.updateBallPrediction();
    const t0 = performance.now();
    blue.think(sim, blueOuts);
    const t1 = performance.now();
    red.think(sim, redOuts);
    const t2 = performance.now();
    st[0].thinkMs += t1 - t0;
    st[1].thinkMs += t2 - t1;
    st[0].botTicks += blueSlots.length;
    st[1].botTicks += redSlots.length;
    for (let i = 0; i < blueSlots.length; i++) sim.setControls(sim.carIdOf(blueSlots[i]), blueOuts[i]);
    for (let i = 0; i < redSlots.length; i++) sim.setControls(sim.carIdOf(redSlots[i]), redOuts[i]);
    const goalsBefore = st[0].goals + st[1].goals;
    sim.step(1);
    sim.sync();
    if (pendingShot !== null && sim.tickCount > pendingShot.tick) {
      // Blue attacks +y (red's goal), red attacks -y.
      const goalY = pendingShot.team === T.Team.Blue ? L : -L;
      if (onTarget(goalY)) st[pendingShot.team].shots++;
      if (sim.buf[T.BALL_OFFSET + T.B_VEL + 1] * Math.sign(goalY) > 500) st[pendingShot.team].forward++;
      pendingShot = null;
    }
    if (st[0].goals + st[1].goals > goalsBefore) goalPause = GOAL_PAUSE_TICKS;
    if (sim.buf[T.BALL_OFFSET + T.B_POS + 2] > 500) highTicks++;
  }
  const a = aIsBlue ? st[0] : st[1];
  const b = aIsBlue ? st[1] : st[0];
  return { a, b, high: highTicks / total };
}

const fmt = (x) => x.toFixed(2).padStart(6);
const overrides = `${arg('tuneA', '') ? ' tuneA ' + arg('tuneA', '') : ''}${arg('paramsA', '') ? ' paramsA ' + arg('paramsA', '') : ''}`;
console.log(`bot bench: A = ${A.label} (${diffA}) vs B = ${B.label} (${diffB}), ${matches} x ${seconds} s per mode${overrides}`);
const summary = [];
const results = { a: A.label, b: B.label, difficultyA: diffA, difficultyB: diffB, seconds, overrides: overrides.trim(), modes: {} };
for (const mode of modes) {
  const t0 = performance.now();
  const sum = { a: emptyStats(), b: emptyStats() };
  let high = 0;
  let w = 0, d = 0, l = 0;
  for (let m = 0; m < matches; m++) {
    const r = playMatch(mode, m % 2 === 0, seed0 + Math.floor(m / 2));
    for (const k of Object.keys(sum.a)) {
      sum.a[k] += r.a[k];
      sum.b[k] += r.b[k];
    }
    high += r.high;
    if (r.a.goals > r.b.goals) w++;
    else if (r.a.goals === r.b.goals) d++;
    else l++;
    console.log(`  ${mode} #${m + 1} (A ${m % 2 === 0 ? 'blue' : 'red '}): A ${r.a.goals} - ${r.b.goals} B   shots ${r.a.shots}/${r.b.shots} aerial ${r.a.aerial}/${r.b.aerial} passes ${r.a.passes}/${r.b.passes} own ${r.a.own}/${r.b.own}`);
  }
  const per = (k, side) => sum[side][k] / matches;
  const us = (side) => (1000 * sum[side].thinkMs) / Math.max(1, sum[side].botTicks);
  const s = scoreSummary(w, d, l);
  const line =
    `${mode}: A won ${w}, drew ${d}, lost ${l}; ${s.text}\n` +
    `     per match A / B: goals ${fmt(per('goals', 'a'))} /${fmt(per('goals', 'b'))}  shots ${fmt(per('shots', 'a'))} /${fmt(per('shots', 'b'))}  aerial ${fmt(per('aerial', 'a'))} /${fmt(per('aerial', 'b'))}  passes ${fmt(per('passes', 'a'))} /${fmt(per('passes', 'b'))}  own ${fmt(per('own', 'a'))} /${fmt(per('own', 'b'))}  touches ${fmt(per('touches', 'a'))} /${fmt(per('touches', 'b'))}  forward% ${fmt((100 * sum.a.forward) / Math.max(1, sum.a.touches))} /${fmt((100 * sum.b.forward) / Math.max(1, sum.b.touches))}\n` +
    `     think() per bot and tick A / B: ${us('a').toFixed(1)} / ${us('b').toFixed(1)} us   ball high ${fmt((100 * high) / matches)}%   (${((performance.now() - t0) / 1000).toFixed(0)} s)`;
  summary.push(line);
  results.modes[mode] = { matches, won: w, drew: d, lost: l, score: s.score, scoreLo: s.lo, scoreHi: s.hi, elo: s.elo, thinkUsA: us('a'), thinkUsB: us('b'), perMatchA: Object.fromEntries(Object.keys(sum.a).map((k) => [k, per(k, 'a')])), perMatchB: Object.fromEntries(Object.keys(sum.b).map((k) => [k, per(k, 'b')])) };
}
console.log('\n' + summary.join('\n'));
if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify(results, null, 2));
  console.log(`results written to ${jsonOut}`);
}
