// node --test tests/match.test.mjs
// Node 24 strips the types from Match.ts natively (erasable syntax only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../src/game/Match.ts';

const DT = 1 / 120;

/** Advance `seconds` of ticks and collect every event, with the tick index each was produced at. */
function advance(match, seconds, onEvent) {
  const ticks = Math.round(seconds * 120);
  const events = [];
  for (let i = 0; i < ticks; i++) {
    const evs = match.tick(DT);
    for (const e of evs) {
      events.push({ ...e, tick: i });
      if (onEvent) onEvent(e, i);
    }
  }
  return events;
}

/** Tick until `pred(match)` holds (checked after each tick) or `maxSeconds` pass. */
function advanceUntil(match, pred, maxSeconds) {
  const events = [];
  const ticks = Math.round(maxSeconds * 120);
  for (let i = 0; i < ticks; i++) {
    for (const e of match.tick(DT)) events.push({ ...e, tick: i });
    if (pred(match)) return events;
  }
  throw new Error(`condition not reached within ${maxSeconds}s (phase ${match.phase})`);
}

function types(events) {
  return events.map((e) => e.type);
}

/** Start a match and run through the kickoff countdown into 'playing'. */
function startPlaying(cfg) {
  const m = new Match(cfg);
  m.start();
  advance(m, (cfg?.kickoffCountdownSeconds ?? 3) + DT);
  assert.equal(m.phase, 'playing');
  return m;
}

test('start → countdown 3,2,1 → go, cars frozen only during the countdown', () => {
  const m = new Match({ lengthSeconds: 300 });
  assert.equal(m.phase, 'menu');
  assert.equal(m.clock, 300);
  m.start();
  assert.equal(m.phase, 'kickoff');
  assert.equal(m.frozen, true);
  assert.equal(m.countdownNumber, 3);

  // First tick delivers the queued kickoff events.
  const first = m.tick(DT);
  assert.deepEqual(types(first), ['kickoffReset', 'freeze', 'countdown']);
  assert.equal(first[1].frozen, true);
  assert.equal(first[2].n, 3);

  // Remaining countdown: "2" after ~1 s, "1" after ~2 s, "go" after ~3 s.
  const evs = advance(m, 3.5);
  const countdowns = evs.filter((e) => e.type === 'countdown');
  assert.deepEqual(
    countdowns.map((e) => e.n),
    [2, 1],
  );
  // Each number lands within one tick of its second boundary (tick index counts from the 2nd tick).
  assert.ok(Math.abs(countdowns[0].tick - (120 - 1)) <= 1, `countdown 2 at tick ${countdowns[0].tick}`);
  assert.ok(Math.abs(countdowns[1].tick - (240 - 1)) <= 1, `countdown 1 at tick ${countdowns[1].tick}`);
  const go = evs.find((e) => e.type === 'go');
  assert.ok(go, 'go event');
  assert.ok(Math.abs(go.tick - (360 - 1)) <= 1, `go at tick ${go.tick}`);
  const unfreeze = evs.find((e) => e.type === 'freeze');
  assert.ok(unfreeze && unfreeze.frozen === false && unfreeze.tick === go.tick, 'unfreeze with go');

  assert.equal(m.phase, 'playing');
  assert.equal(m.frozen, false);
  assert.equal(m.countdownNumber, 0);
  // Clock did not run during the countdown, only during the ~0.5 s of play.
  assert.ok(m.clock < 300 && m.clock > 299.4, `clock ${m.clock}`);
  assert.equal(m.formatClock(), '5:00'); // ceil: 299.5 s shows as 5:00
});

test('goal → score, goal pause (clock stopped) → kickoff countdown', () => {
  const m = startPlaying({ lengthSeconds: 300, goalPauseSeconds: 3 });
  advance(m, 10);
  const clockAtGoal = m.clock;
  assert.ok(clockAtGoal < 290.1 && clockAtGoal > 289.9, `clock ${clockAtGoal}`);

  assert.equal(m.onGoal(1), true); // red scores
  assert.equal(m.phase, 'goal');
  assert.deepEqual(m.score, { blue: 0, red: 1 });
  assert.equal(m.lastGoalTeam, 1);
  assert.equal(m.leader, 1);

  const first = m.tick(DT);
  assert.deepEqual(types(first), ['goal']);
  assert.equal(first[0].team, 1);
  assert.equal(first[0].red, 1);

  // A second goal call during the pause is ignored (and reported as not counted).
  assert.equal(m.onGoal(0), false);
  assert.deepEqual(m.score, { blue: 0, red: 1 });

  const evs = advance(m, 2.9);
  assert.deepEqual(types(evs), []);
  assert.equal(m.phase, 'goal');
  assert.equal(m.clock, clockAtGoal, 'clock frozen during the goal pause');

  const after = advance(m, 0.2);
  assert.deepEqual(types(after), ['kickoffReset', 'freeze', 'countdown']);
  assert.equal(after[1].frozen, true);
  assert.equal(after[2].n, 3);
  assert.equal(m.phase, 'kickoff');
  assert.equal(m.clock, clockAtGoal, 'clock still frozen in the kickoff');

  // And the match resumes with the same score.
  advance(m, 3.1);
  assert.equal(m.phase, 'playing');
  assert.deepEqual(m.score, { blue: 0, red: 1 });
});

test('clock expiry with a lead → ended with the leader as winner', () => {
  const m = startPlaying({ lengthSeconds: 5, goalPauseSeconds: 1, kickoffCountdownSeconds: 1 });
  m.onGoal(0);
  advance(m, 1 + 1 + 2 * DT); // goal pause + kickoff countdown
  assert.equal(m.phase, 'playing');
  assert.equal(m.overtime, false);
  assert.equal(m.winner, null);

  // A few ticks of play already elapsed around the kickoffs; the end must land when the
  // remaining clock runs out, not at a fixed 5 s.
  const remaining = m.clock;
  assert.ok(remaining > 4.9 && remaining < 5, `remaining ${remaining}`);
  const evs = advance(m, 6);
  const ended = evs.filter((e) => e.type === 'ended');
  assert.equal(ended.length, 1);
  assert.equal(ended[0].winner, 0);
  const expectedTick = Math.round(remaining * 120) - 1;
  assert.ok(Math.abs(ended[0].tick - expectedTick) <= 1, `ended at tick ${ended[0].tick}, expected ~${expectedTick}`);
  assert.equal(m.phase, 'ended');
  assert.equal(m.winner, 0);
  assert.equal(m.clock, 0);
  assert.equal(m.formatClock(), '0:00');
  assert.ok(!evs.some((e) => e.type === 'overtime'));

  // Nothing happens after the end; goals are ignored.
  m.onGoal(1);
  assert.deepEqual(m.score, { blue: 1, red: 0 });
  assert.deepEqual(types(advance(m, 1)), []);
  assert.equal(m.phase, 'ended');
});

test('tie at 0:00 → overtime kickoff → golden goal ends the match', () => {
  const m = startPlaying({ lengthSeconds: 2, goalPauseSeconds: 1, kickoffCountdownSeconds: 2 });
  m.onGoal(0);
  advance(m, 1 + 2 + 2 * DT);
  m.onGoal(1);
  advance(m, 1 + 2 + 2 * DT);
  assert.equal(m.phase, 'playing');
  assert.deepEqual(m.score, { blue: 1, red: 1 });

  const evs = advance(m, 2.5);
  assert.deepEqual(types(evs), ['overtime', 'kickoffReset', 'freeze', 'countdown']);
  assert.equal(evs[3].n, 2);
  assert.equal(m.phase, 'overtime-kickoff');
  assert.equal(m.overtime, true);
  assert.equal(m.frozen, true);
  assert.equal(m.clock, 0);
  assert.equal(m.winner, null);

  // Overtime countdown → playing, overtime clock counts up from 0.
  const ot = advanceUntil(m, (mm) => mm.phase === 'playing', 5);
  assert.ok(ot.some((e) => e.type === 'go'));
  assert.ok(ot.some((e) => e.type === 'countdown' && e.n === 1));
  assert.equal(m.phase, 'playing');
  assert.ok(m.overtimeClock < 0.02, `overtime clock starts at ${m.overtimeClock}`);
  advance(m, 1.5);
  assert.ok(Math.abs(m.overtimeClock - 1.5) < 0.02, `overtime clock ${m.overtimeClock}`);
  assert.equal(m.clock, 0, 'regulation clock stays at 0');
  assert.equal(m.formatClock(), '+0:01');

  // Golden goal: goal pause, then ended, no further kickoff.
  m.onGoal(1);
  assert.equal(m.phase, 'goal');
  const end = advance(m, 1.2);
  assert.deepEqual(types(end), ['goal', 'ended']);
  assert.equal(end[1].winner, 1);
  assert.equal(m.phase, 'ended');
  assert.equal(m.winner, 1);
  assert.deepEqual(m.score, { blue: 1, red: 2 });
});

test('unlimited match never ends by clock and the display counts up', () => {
  const m = startPlaying({ lengthSeconds: 0, kickoffCountdownSeconds: 0 });
  assert.equal(m.isUnlimited, true);
  const evs = advance(m, 70);
  assert.deepEqual(types(evs), []);
  assert.equal(m.phase, 'playing');
  assert.equal(m.overtime, false);
  assert.equal(m.formatClock(), '1:10');
});

test('kickoff countdown of 0 goes straight to playing; reset returns to menu', () => {
  const m = new Match({ kickoffCountdownSeconds: 0 });
  m.start();
  const first = m.tick(DT);
  assert.deepEqual(types(first), ['kickoffReset', 'freeze', 'go', 'freeze']);
  assert.equal(first[1].frozen, true);
  assert.equal(first[3].frozen, false);
  assert.equal(m.phase, 'playing');

  advance(m, 3);
  m.onGoal(0);
  m.reset();
  assert.equal(m.phase, 'menu');
  assert.deepEqual(m.score, { blue: 0, red: 0 });
  assert.equal(m.clock, 180); // the default regulation length (DEFAULT_MATCH_SECONDS)
  assert.equal(m.formatClock(), '3:00');
  assert.equal(m.overtime, false);
  assert.equal(m.winner, null);
  // Queued goal event was discarded by reset(); the menu produces nothing.
  assert.deepEqual(types(advance(m, 1)), []);
});

test('paused match delivers queued events but advances nothing', () => {
  const m = new Match();
  m.start();
  m.paused = true;
  const first = m.tick(DT);
  assert.deepEqual(types(first), ['kickoffReset', 'freeze', 'countdown']);
  assert.deepEqual(types(advance(m, 5)), []);
  assert.equal(m.phase, 'kickoff');
  assert.equal(m.countdownNumber, 3);
  m.paused = false;
  advance(m, 3.1);
  assert.equal(m.phase, 'playing');
});

test('tick() reuses its event array and allocates no events on quiet ticks', () => {
  const m = startPlaying();
  const a = m.tick(DT);
  const b = m.tick(DT);
  assert.equal(a, b);
  assert.equal(a.length, 0);
});
