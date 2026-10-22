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
//
// Experimental physics cost (docs/experimental.md): --preset=<id>[,<id>...] (or `--preset <id>`)
// plays the same matches with stock physics and with each preset (src/game/physicsRules.ts), both
// teams this tree's bots with the preset's physics profile, and compares what a tick costs:
//   node scripts/bot-bench.mjs --preset=arcade [--modes=3v3] [--matches=4] [--seconds=120]
//                              [--difficulty=hard] [--seed=1] [--predEvery=4] [--json=cost.json]
//   <id>: a built-in (standard, lowGravity, fastBall, bouncy, arcade), `builtins` (the four that
//   change something), `min` / `max` (every match key at its lowest / highest grid value),
//   `extremes` (min and max), or one set of values as `gravity=50,ballDrag=50` or as JSON. The
//   values go through the strict parser in the match context (game speed is free play only: it
//   changes how many ticks run per second, not what a tick costs, so it is refused here).
// Per mode and preset it prints the physics step per tick, think() per bot and tick, one ball
// prediction refresh (incremental; the full one is measured once per match), the total per tick and
// its change from stock, plus goals / touches / bumps / demolitions and the top ball and car speeds.
// Stock and preset matches alternate with the same seeds, so CPU drift hits both alike.
// --predEvery=1 refreshes the prediction every tick, as P2P does on confirmed ticks (the offline
// game: 4; Super low: 8). A refresh that costs like a full 720-tick prediction means the predictor
// is not running the preset's physics; that, or a non-finite state, prints "!!" and exits with 1.
// Run it on the slowest device you care about (the Mali-G31 TV class) for numbers that matter.
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

const presetArg = arg('preset', '');
const A = await loadBots(null);
applyOverrides(A, arg('tuneA', ''), arg('paramsA', ''));
// The cost bench needs no git revision: both teams are this tree's bots.
const B = presetArg === '' ? await loadBots(baseline) : null;
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
if (presetArg !== '') {
  const failed = await presetBench(presetArg);
  process.exit(failed ? 1 : 0);
}
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

// ---- --preset: what experimental physics costs per tick, against stock -------------------------

/** The presets `spec` names, as [{ id, values }] strictly parsed in the match context. Throws on anything else. */
function presetList(spec, R) {
  const matchFields = R.PHYSICS_FIELDS.filter((f) => f.scope === 'all');
  const corner = (pick) => Object.fromEntries(matchFields.map((f) => [f.key, pick(R.fieldValues(f))]));
  const corners = { min: () => corner((vals) => vals[0]), max: () => corner((vals) => vals.at(-1)) };
  const check = (id, raw) => {
    const values = R.parsePhysicsValues(raw, 'strict', 'match');
    if (values === null) throw new Error(`--preset ${id}: not valid match rules (an unknown key, a value off the grid or out of range, or game speed)`);
    return { id, values: R.canonicalValues(values, 'match') };
  };
  const t = spec.trim();
  if (t.startsWith('{')) return [check('custom', JSON.parse(t))];
  if (t.includes('=')) {
    const raw = {};
    for (const kv of t.split(',').filter(Boolean)) {
      const [k, v] = kv.split('=');
      raw[k.trim()] = Number(v);
    }
    return [check('custom', raw)];
  }
  const out = [];
  for (const id of t.split(',').map((x) => x.trim()).filter(Boolean)) {
    if (id === 'builtins') {
      for (const p of R.BUILT_IN_PRESETS) if (!R.isStock(p.values, 'match')) out.push(check(p.id, p.values));
    } else if (id === 'extremes') out.push(check('min', corners.min()), check('max', corners.max()));
    else if (id in corners) out.push(check(id, corners[id]()));
    else {
      const p = R.BUILT_IN_PRESETS.find((b) => b.id === id);
      if (p === undefined) throw new Error(`--preset: unknown preset '${id}' (built-ins: ${R.BUILT_IN_PRESETS.map((b) => b.id).join(', ')}; or builtins, min, max, extremes, key=value,...)`);
      out.push(check(p.id, p.values));
    }
  }
  if (out.length === 0) throw new Error('--preset: no preset given');
  return out;
}

function emptyCost() {
  return { matches: 0, ticks: 0, playTicks: 0, stepMs: 0, thinkMs: 0, botTicks: 0, predMs: 0, predCalls: 0, fullPredMs: 0, goals: 0, touches: 0, bumps: 0, demos: 0, maxBall: 0, maxCar: 0, nonFinite: 0 };
}

/** One bot match on stock physics (values null) or a preset's; adds its costs and counts to `acc`. */
function costMatch(M, mode, values, seed, predEvery, acc) {
  const perTeam = MODES[mode];
  sim.createArena(T.TICK_RATE, values === null ? null : M.arenaMutators({ v: 1, values }));
  sim.events.onGoal = sim.events.onBump = sim.events.onBallHit = undefined;
  for (let i = 0; i < perTeam; i++) sim.addCar(T.Team.Blue, T.CarPreset.Standard);
  for (let i = 0; i < perTeam; i++) sim.addCar(T.Team.Red, T.CarPreset.Standard);
  let kickoffSeed = seed * 31;
  sim.resetKickoff(kickoffSeed++);
  sim.sync();
  const slotBuf = new Int32Array(T.MAX_CARS);
  const slotsOf = (team) => Array.from(slotBuf.subarray(0, sim.slotsOfTeam(team, slotBuf)));
  const blueSlots = slotsOf(T.Team.Blue);
  const redSlots = slotsOf(T.Team.Red);
  const allSlots = [...blueSlots, ...redSlots];
  // The preset's physics profile (the bots plan with its gravity, jump, boost and top speed).
  const physics = values === null ? undefined : M.botPhysicsOf(values);
  const blue = new A.BotTeam({ team: T.Team.Blue, difficulty: diffA, seed: seed * 7919 + 777, physics });
  const red = new A.BotTeam({ team: T.Team.Red, difficulty: diffA, seed: seed * 7919 + 7, physics });
  blue.setSlots(blueSlots);
  red.setSlots(redSlots);
  const blueOuts = blueSlots.map(() => T.emptyControls());
  const redOuts = redSlots.map(() => T.emptyControls());
  sim.events.onGoal = () => acc.goals++;
  sim.events.onBallHit = () => acc.touches++;
  sim.events.onBump = (_a, _b, demo) => {
    acc.bumps++;
    if (demo) acc.demos++;
  };
  // The one-off full prediction: what createArena's warm-up pays, and what every refresh would
  // cost if the predictor ran other physics than the arena.
  const f0 = performance.now();
  sim.forceBallPrediction();
  acc.fullPredMs += performance.now() - f0;
  const buf = sim.buf;
  const bo = T.BALL_OFFSET;
  const total = seconds * T.TICK_RATE;
  let goalPause = 0;
  for (let tick = 1; tick <= total; tick++) {
    if (goalPause > 0) {
      if (--goalPause === 0) {
        sim.resetKickoff(kickoffSeed++);
        sim.sync();
        blue.reset();
        red.reset();
      }
    } else {
      const age = sim.tickCount - sim.predTick;
      if (age >= predEvery || age < 0) {
        const p0 = performance.now();
        sim.updateBallPrediction();
        acc.predMs += performance.now() - p0;
        acc.predCalls++;
      }
      const t0 = performance.now();
      blue.think(sim, blueOuts);
      red.think(sim, redOuts);
      acc.thinkMs += performance.now() - t0;
      acc.botTicks += allSlots.length;
      acc.playTicks++;
      for (let i = 0; i < blueSlots.length; i++) sim.setControls(sim.carIdOf(blueSlots[i]), blueOuts[i]);
      for (let i = 0; i < redSlots.length; i++) sim.setControls(sim.carIdOf(redSlots[i]), redOuts[i]);
    }
    const goalsBefore = acc.goals;
    const s0 = performance.now();
    sim.step(1);
    sim.sync();
    acc.stepMs += performance.now() - s0;
    acc.ticks++;
    if (acc.goals > goalsBefore) goalPause = GOAL_PAUSE_TICKS;
    const bv = Math.hypot(buf[bo + T.B_VEL], buf[bo + T.B_VEL + 1], buf[bo + T.B_VEL + 2]);
    if (!Number.isFinite(bv) || !Number.isFinite(buf[bo + T.B_POS] + buf[bo + T.B_POS + 1] + buf[bo + T.B_POS + 2])) acc.nonFinite++;
    else if (bv > acc.maxBall) acc.maxBall = bv;
    for (const slot of allSlots) {
      const co = sim.carOffset(slot);
      const cv = Math.hypot(buf[co + T.C_VEL], buf[co + T.C_VEL + 1], buf[co + T.C_VEL + 2]);
      if (!Number.isFinite(cv)) acc.nonFinite++;
      else if (cv > acc.maxCar) acc.maxCar = cv;
    }
  }
  acc.matches++;
}

/** Per-tick costs in microseconds: the step, think() per bot, one refresh, and what a whole tick pays. */
function costOf(c) {
  return {
    step: (1000 * c.stepMs) / Math.max(1, c.ticks),
    think: (1000 * c.thinkMs) / Math.max(1, c.botTicks),
    refresh: (1000 * c.predMs) / Math.max(1, c.predCalls),
    fullMs: c.fullPredMs / Math.max(1, c.matches),
    tick: (1000 * (c.stepMs + c.thinkMs + c.predMs)) / Math.max(1, c.ticks),
  };
}

/** The --preset run. True when a preset broke something (a non-finite state, a predictor off its physics). */
async function presetBench(spec) {
  const R = await import(new URL('../src/game/physicsRules.ts', import.meta.url).href);
  const M = await import(new URL('../src/sim/mutators.ts', import.meta.url).href);
  const presets = presetList(spec, R);
  const predEvery = Math.max(1, Math.floor(Number(arg('predEvery', '4'))));
  console.log(
    `preset bench: this tree's bots (${diffA}) on both teams with each preset's physics profile, ${matches} x ${seconds} s per mode and preset, ` +
      `ball prediction every ${predEvery} tick${predEvery === 1 ? ' (as P2P)' : 's'}\n  ${presets.map((p) => `${p.id} ${JSON.stringify(p.values)}`).join('\n  ')}`,
  );
  const results = { difficulty: diffA, seconds, matches, predEvery, modes: {} };
  const blocks = [];
  let failed = false;
  // One short stock match first, untimed: the JIT and the wasm warm up before anything is compared.
  costMatch(M, modes[0], null, seed0 + 999, predEvery, emptyCost());
  for (const mode of modes) {
    const t0 = performance.now();
    const stock = emptyCost();
    const per = presets.map(() => emptyCost());
    for (let m = 0; m < matches; m++) {
      // Stock and the presets in turn on the same seed, the order flipped every match.
      const order = [-1, ...presets.map((_, i) => i)];
      if (m % 2 === 1) order.reverse();
      for (const i of order) costMatch(M, mode, i < 0 ? null : presets[i].values, seed0 + m, predEvery, i < 0 ? stock : per[i]);
    }
    const s = costOf(stock);
    const change = (x, base) => `${x >= base ? '+' : ''}${((100 * (x - base)) / Math.max(1e-9, base)).toFixed(0)}%`;
    const row = (id, c, k) =>
      `  ${id.padEnd(11)} step ${k.step.toFixed(1).padStart(6)} us  think ${k.think.toFixed(1).padStart(5)} us/bot  refresh ${k.refresh.toFixed(1).padStart(6)} us (full ${k.fullMs.toFixed(2)} ms)  ` +
      `tick ${k.tick.toFixed(1).padStart(6)} us${c === stock ? '        ' : ` ${change(k.tick, s.tick).padStart(6)} `}  ` +
      `goals ${(c.goals / c.matches).toFixed(1)}  touches ${(c.touches / c.matches).toFixed(0)}  bumps ${(c.bumps / c.matches).toFixed(0)}  demos ${(c.demos / c.matches).toFixed(1)}  ` +
      `top ball ${Math.round(c.maxBall)} / car ${Math.round(c.maxCar)} uu/s${c.nonFinite > 0 ? `  NON-FINITE x${c.nonFinite}` : ''}`;
    const out = [`${mode} (${MODES[mode] * 2} bots; per tick: step, think() per bot, one prediction refresh, the whole tick; ${((performance.now() - t0) / 1000).toFixed(0)} s)`, row('stock', stock, s)];
    results.modes[mode] = { stock: { ...s, counts: stock }, presets: {} };
    presets.forEach((p, i) => {
      const k = costOf(per[i]);
      out.push(row(p.id, per[i], k));
      results.modes[mode].presets[p.id] = { values: p.values, ...k, tickChange: (k.tick - s.tick) / s.tick, counts: per[i] };
      if (per[i].nonFinite > 0) {
        out.push(`  !! ${p.id}: a non-finite ball or car state (the table or the wasm's hard limits let a broken value through)`);
        failed = true;
      }
      // An incremental refresh that costs about a full prediction: the predictor's arena keeps stock
      // physics (rs_set_mutators must copy the config into it), so every refresh re-predicts 720 ticks.
      if (k.refresh > Math.max(3 * s.refresh, 250 * k.fullMs)) {
        out.push(`  !! ${p.id}: a prediction refresh costs ${k.refresh.toFixed(0)} us against ${s.refresh.toFixed(0)} us on stock: the predictor does not run the preset's physics`);
        failed = true;
      }
    });
    console.log(out.join('\n'));
    blocks.push(out.join('\n'));
  }
  if (modes.length > 1) console.log('\n' + blocks.join('\n'));
  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify(results, null, 2));
    console.log(`results written to ${jsonOut}`);
  }
  return failed;
}
