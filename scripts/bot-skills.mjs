// Bot skills: fixed scenarios on the real physics, for the bots of this working tree (A) and of a
// git revision (B), side by side. Matches (scripts/bot-bench.mjs) say who wins; this says what the
// bots can do, without the noise of a whole match.
//   node scripts/bot-skills.mjs [--baseline=origin/main] [--difficulty=medium,hard]
//                               [--only=shots,aerials,saves,approach,recovery,kickoffs]
//                               [--tuneA=...] [--paramsA=...] [--json=skills.json] [-v]
// Every scenario: one blue bot (attacks +y, defends the goal at -y), the other car idle far away
// unless the family says otherwise, the bot's car placed with a starting speed, controls from
// Bot.think every tick, ball prediction every 4 ticks.
//   shots     7 set-ups x 3 positions of a red car parked on its goal line: goal within 6 s; the
//             first touch on target (ballistic toward the mouth) and its speed
//   aerials   a ball in the air ahead (5 set-ups), full boost: met in the air (car above 250 uu)
//             and sent toward their goal (> 800 uu/s along +y)
//   saves     the bot in front of its goal, a ball shot at it (12 shots: 3 ball starts x 3 aims,
//             plus 3 high): no goal within 3.5 s
//   approach  a still ball, the car 2000 uu away in 8 directions x 2 headings: time to the first
//             touch, and the share of first touches that send the ball toward +y
//   recovery  the car dropped from 600 uu in 8 tumbling orientations: on its wheels, upright,
//             within 2.5 s, and how long it took
//   kickoffs  A against B (5 kickoff spots, both sides): who touches first, and whose half the
//             ball is in 1.5 s after the first touch
import { writeFileSync } from 'node:fs';
import { applyOverrides, arg, loadBots, loadSim } from './bot-lib.mjs';

const baseline = arg('baseline', 'origin/main');
const difficulties = arg('difficulty', 'medium,hard').split(',');
const only = arg('only', 'shots,aerials,saves,approach,recovery,kickoffs').split(',');
const verbose = process.argv.includes('-v');
const jsonOut = arg('json', '');

const A = await loadBots(null);
applyOverrides(A, arg('tuneA', ''), arg('paramsA', ''));
const B = await loadBots(baseline);
const { sim, C, T } = await loadSim();
const L = C.ARENA.extentY;
const GRAV = 650;
const TR = T.TICK_RATE;

const ball = () => {
  const o = T.BALL_OFFSET;
  return { x: sim.buf[o + T.B_POS], y: sim.buf[o + T.B_POS + 1], z: sim.buf[o + T.B_POS + 2], vx: sim.buf[o + T.B_VEL], vy: sim.buf[o + T.B_VEL + 1], vz: sim.buf[o + T.B_VEL + 2] };
};
const carAt = (slot, f) => sim.buf[sim.carOffset(slot) + f];

/**
 * One blue bot (slot 0) and a red car (slot 1, idle unless `redBot` drives it). `place` sets the
 * cars and the ball; `step(t)` runs after every tick and returns true to stop. Returns the tick count.
 */
function scenario(lib, difficulty, place, step, maxTicks, redBot = null) {
  sim.createArena(TR);
  const me = sim.addCar(T.Team.Blue, T.CarPreset.Standard);
  const other = sim.addCar(T.Team.Red, T.CarPreset.Standard);
  sim.setCarState(other, [3600, 4600, 17], [Math.PI, 0, 0]);
  place(me, other);
  sim.sync();
  const bot = new lib.Bot({ team: T.Team.Blue, difficulty, seed: 9 });
  const c = T.emptyControls();
  const rc = T.emptyControls();
  let t = 0;
  for (; t < maxTicks; t++) {
    if (t % 4 === 0) sim.updateBallPrediction();
    bot.think(sim, 0, 1, c);
    sim.setControls(me, c);
    if (redBot !== null) redBot.think(sim, 1, 0, rc);
    sim.setControls(other, redBot !== null ? rc : T.emptyControls());
    sim.step(1);
    sim.sync();
    if (step(t)) break;
  }
  sim.events.onGoal = undefined;
  sim.events.onBallHit = undefined;
  return t;
}

/** Launch velocity from `from` that reaches `to` after `t` seconds (ballistic). */
function launch(from, to, t) {
  return [(to[0] - from[0]) / t, (to[1] - from[1]) / t, (to[2] - from[2]) / t + 0.5 * GRAV * t];
}

// ---- families ---------------------------------------------------------------------------------

function shots(lib, difficulty) {
  const setups = [
    { name: 'straight, ball still', car: [0, 0], ball: [0, 2000, 93], vel: [0, 0, 0] },
    { name: 'angled 30 deg', car: [-1500, 0], ball: [-600, 2500, 93], vel: [0, 0, 0] },
    { name: 'wide right', car: [2500, 500], ball: [2200, 3200, 93], vel: [0, 0, 0] },
    { name: 'rolling across', car: [0, 1000], ball: [-1500, 3000, 93], vel: [700, 0, 0] },
    { name: 'rolling toward us', car: [500, 0], ball: [0, 3500, 93], vel: [0, -800, 0] },
    { name: 'bouncing', car: [0, 500], ball: [300, 2500, 400], vel: [0, 0, 300] },
    { name: 'close range', car: [-300, 3000], ball: [0, 4000, 93], vel: [0, 0, 0] },
  ];
  let goals = 0, onTarget = 0, speed = 0, n = 0;
  for (const s of setups) {
    for (const kx of [-400, 0, 400]) {
      let scored = false;
      let first = null;
      scenario(
        lib,
        difficulty,
        (me, other) => {
          sim.setCarState(other, [kx, L + 120, 17], [-Math.PI / 2, 0, 0]);
          const yaw = Math.atan2(s.ball[1] - s.car[1], s.ball[0] - s.car[0]);
          sim.setCarState(me, [s.car[0], s.car[1], 17], [yaw, 0, 0], [Math.cos(yaw) * 500, Math.sin(yaw) * 500, 0]);
          sim.setCarBoost(me, 60);
          sim.setBallState(s.ball, s.vel);
          sim.events.onGoal = (team) => (scored ||= team === T.Team.Blue);
          sim.events.onBallHit = (id) => {
            if (id !== me || first !== null) return;
            const b = ball();
            const t = b.vy > 50 ? (L - b.y) / b.vy : -1;
            first = { on: t > 0 && t < 3 && Math.abs(b.x + b.vx * t) < C.ARENA.goalHalfWidth, speed: Math.hypot(b.vx, b.vy, b.vz) };
          };
        },
        () => scored,
        6 * TR,
      );
      n++;
      if (scored) goals++;
      if (first?.on) onTarget++;
      if (first) speed += first.speed;
      if (verbose) console.log(`  shots ${difficulty} ${s.name} keeper ${kx}: ${scored ? 'GOAL' : 'miss'}${first ? `, first touch ${first.on ? 'on target' : 'off'} ${first.speed.toFixed(0)} uu/s` : ''}`);
    }
  }
  return { score: goals / n, cells: [`goals ${goals}/${n}`, `on target ${onTarget}/${n}`, `speed ${(speed / Math.max(1, n)).toFixed(0)}`] };
}

function aerials(lib, difficulty) {
  const setups = [
    { name: 'floating ball ahead, 700 high', car: [0, -1500], ball: [0, 0, 700], vel: [0, 0, 250] },
    { name: 'lob coming down ahead, 900 high', car: [0, -2200], ball: [0, 0, 900], vel: [0, -200, 0] },
    { name: 'ball rising beside the car', car: [-800, -1000], ball: [-300, 600, 400], vel: [0, 0, 700] },
    { name: 'high ball near their goal', car: [0, 2500], ball: [0, 4300, 800], vel: [0, 0, 100] },
    { name: 'cross in front of their goal', car: [600, 2600], ball: [-1800, 4200, 600], vel: [900, 0, 300] },
  ];
  let air = 0, good = 0;
  for (const s of setups) {
    let touch = null;
    scenario(
      lib,
      difficulty,
      (me) => {
        sim.setCarState(me, [s.car[0], s.car[1], 17], [Math.PI / 2, 0, 0], [0, 800, 0]);
        sim.setCarBoost(me, 100);
        sim.setBallState(s.ball, s.vel);
        sim.events.onBallHit = (id) => {
          if (id !== me || touch !== null) return;
          touch = { z: carAt(0, T.C_POS + 2), air: carAt(0, T.C_IS_ON_GROUND) < 0.5, vy: ball().vy };
        };
      },
      () => touch !== null,
      3 * TR,
    );
    const inAir = touch !== null && touch.air && touch.z > 250;
    if (inAir) air++;
    if (inAir && touch.vy > 800) good++;
    if (verbose) console.log(`  aerials ${difficulty} ${s.name}: ${touch === null ? 'no touch' : `car z ${touch.z.toFixed(0)}${touch.air ? ' in the air' : ''}, ball vy ${touch.vy.toFixed(0)}`}`);
  }
  return { score: good / setups.length, cells: [`in the air ${air}/${setups.length}`, `goalward ${good}/${setups.length}`] };
}

function saves(lib, difficulty) {
  const shotsList = [];
  for (const bx of [-2000, 0, 2000]) for (const tx of [-700, 0, 700]) shotsList.push({ from: [bx, -2600, 200], to: [tx, -L - 50, 200], speed: 2300 });
  for (const bx of [-1200, 0, 1200]) shotsList.push({ from: [bx, -2400, 300], to: [-bx * 0.3, -L - 50, 560], speed: 2000 });
  let saved = 0;
  for (const s of shotsList) {
    let conceded = false;
    const dist = Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1]);
    scenario(
      lib,
      difficulty,
      (me) => {
        sim.setCarState(me, [s.from[0] * 0.25, -L + 700, 17], [Math.PI / 2, 0, 0]);
        sim.setCarBoost(me, 50);
        sim.setBallState(s.from, launch(s.from, s.to, dist / s.speed));
        sim.events.onGoal = (team) => (conceded ||= team === T.Team.Red);
      },
      () => conceded,
      3.5 * TR,
    );
    if (!conceded) saved++;
    if (verbose) console.log(`  saves ${difficulty} from ${s.from[0]} at ${s.to[0]},${s.to[2]}: ${conceded ? 'GOAL against' : 'saved'}`);
  }
  return { score: saved / shotsList.length, cells: [`saved ${saved}/${shotsList.length}`] };
}

function approach(lib, difficulty) {
  let n = 0, touched = 0, time = 0, forward = 0;
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    for (const away of [false, true]) {
      const x = Math.cos(a) * 2000;
      const y = Math.sin(a) * 2000;
      const yaw = Math.atan2(-y, -x) + (away ? Math.PI : 0);
      let touch = null;
      const ticks = scenario(
        lib,
        difficulty,
        (me) => {
          sim.setCarState(me, [x, y, 17], [yaw, 0, 0]);
          sim.setCarBoost(me, 33);
          sim.setBallState([0, 0, 93], [0, 0, 0]);
          sim.events.onBallHit = (id) => {
            if (id === me && touch === null) touch = { vy: ball().vy };
          };
        },
        () => touch !== null,
        6 * TR,
      );
      n++;
      if (touch !== null) {
        touched++;
        time += ticks / TR;
        if (touch.vy > 300) forward++;
      }
    }
  }
  return { score: touched === 0 ? 0 : -time / touched, cells: [`touched ${touched}/${n}`, `${touched ? (time / touched).toFixed(2) : '-'} s`, `toward +y ${forward}/${touched}`] };
}

function recovery(lib, difficulty) {
  const spins = [
    [0, 0, Math.PI, [0, 0, 0]],
    [0, Math.PI / 2, 0, [2, 0, 0]],
    [1, -Math.PI / 2, 0.5, [0, 3, 0]],
    [2, 0.8, 2.5, [1, 1, 2]],
    [-1, 2.2, -1, [0, 0, 4]],
    [3, -0.5, -2.8, [3, -1, 0]],
    [0.5, 1.2, 1.7, [-2, 2, 1]],
    [-2, -1, 3, [1, -3, -2]],
  ];
  let ok = 0, time = 0;
  for (const [yaw, pitch, roll, w] of spins) {
    let landed = -1;
    scenario(
      lib,
      difficulty,
      (me) => {
        sim.setCarState(me, [0, 0, 600], [yaw, pitch, roll], [300, 200, 0], w);
        sim.setCarBoost(me, 30);
        sim.setBallState([3000, 3000, 93], [0, 0, 0]);
      },
      (t) => {
        if (carAt(0, T.C_IS_ON_GROUND) > 0.5 && carAt(0, T.C_ROT + 8) > 0.9) {
          landed = t;
          return true;
        }
        return false;
      },
      2.5 * TR,
    );
    if (landed >= 0) {
      ok++;
      time += landed / TR;
    }
  }
  return { score: ok / spins.length, cells: [`upright ${ok}/${spins.length}`, `${ok ? (time / ok).toFixed(2) : '-'} s`] };
}

/** A (blue) against B (red) and the other way round, from 5 kickoff draws. */
function kickoffs(difficulty) {
  let aFirst = 0, aWon = 0, n = 0;
  for (let k = 0; k < 5; k++) {
    for (const aBlue of [true, false]) {
      sim.createArena(TR);
      sim.addCar(T.Team.Blue, T.CarPreset.Standard);
      sim.addCar(T.Team.Red, T.CarPreset.Standard);
      sim.resetKickoff(100 + k);
      sim.sync();
      const blue = new (aBlue ? A : B).Bot({ team: T.Team.Blue, difficulty, seed: 3 });
      const red = new (aBlue ? B : A).Bot({ team: T.Team.Red, difficulty, seed: 4 });
      const cb = T.emptyControls();
      const cr = T.emptyControls();
      let first = null;
      let after = -1;
      sim.events.onBallHit = (id) => {
        if (first === null) first = sim.teamOf(sim.slotOf(id));
      };
      for (let t = 0; t < 6 * TR; t++) {
        if (t % 4 === 0) sim.updateBallPrediction();
        blue.think(sim, 0, 1, cb);
        red.think(sim, 1, 0, cr);
        sim.setControls(sim.carIdOf(0), cb);
        sim.setControls(sim.carIdOf(1), cr);
        sim.step(1);
        sim.sync();
        if (first !== null && after < 0) after = t + 1.5 * TR;
        if (after >= 0 && t >= after) break;
      }
      sim.events.onBallHit = undefined;
      n++;
      const aTeam = aBlue ? T.Team.Blue : T.Team.Red;
      if (first === aTeam) aFirst++;
      // A wins the kickoff when the ball is in B's half (blue attacks +y).
      if ((aBlue ? 1 : -1) * ball().y > 0) aWon++;
    }
  }
  return { cells: [`A first ${aFirst}/${n}`, `A won ${aWon}/${n}`] };
}

// ---- report -----------------------------------------------------------------------------------

const families = { shots, aerials, saves, approach, recovery };
const out = { a: A.label, b: B.label, families: {} };
console.log(`bot skills: A = ${A.label} vs B = ${B.label}`);
for (const name of only) {
  if (name === 'kickoffs') {
    for (const d of difficulties) {
      const r = kickoffs(d);
      console.log(`  kickoffs  ${d.padEnd(6)}  A vs B: ${r.cells.join(', ')}`);
      (out.families.kickoffs ??= {})[d] = r.cells;
    }
    continue;
  }
  const fn = families[name];
  if (fn === undefined) throw new Error('unknown skill family ' + name);
  for (const d of difficulties) {
    const ra = fn(A, d);
    const rb = fn(B, d);
    const mark = ra.score > rb.score ? '  A better' : ra.score < rb.score ? '  A worse' : '';
    console.log(`  ${name.padEnd(9)} ${d.padEnd(6)}  A: ${ra.cells.join(', ').padEnd(44)} B: ${rb.cells.join(', ')}${mark}`);
    (out.families[name] ??= {})[d] = { a: ra.cells, b: rb.cells };
  }
}
if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify(out, null, 2));
  console.log(`results written to ${jsonOut}`);
}
