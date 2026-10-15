// Training rules (node --test tests/training-session.test.mjs): the pure TrainingSession state
// machine (frozen until the first input, timer, grace, judging per category, attempts, reset /
// next / previous, summary, free play) and the records helper (localStorage format, validation,
// best-of). No DOM, no wasm: hooks and storage are fakes.
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

const S = await import('../src/game/TrainingSession.ts');
const R = await import('../src/game/trainingRecords.ts');
const P = await import('../src/game/trainingPacks.ts');
const { emptyControls, TICK_DT } = await import('../src/sim/types.ts');

const { TrainingSession, RESULT_SECONDS, GOALIE_SAVE_SECONDS, FREEPLAY_GOAL_PAUSE_SECONDS, hasCarInput } = S;

// ---- fakes ---------------------------------------------------------------------------------

class FakeStorage {
  constructor(init = {}) {
    this.map = new Map(Object.entries(init));
    this.writes = 0;
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.writes++;
    this.map.set(k, String(v));
  }
}

function recorder() {
  const calls = [];
  const hooks = {
    placeShot: (shot, index) => calls.push(['place', index, shot.name]),
    releaseShot: (shot, index) => calls.push(['release', index]),
    shotResult: (index, pass, reason) => calls.push(['result', index, pass, reason]),
    packSummary: (s) => calls.push(['summary', s.passed, s.total, s.best, s.newBest]),
    freeplayGoal: (team) => calls.push(['fpGoal', team]),
    freeplayReset: (car, ball) => calls.push(['fpReset', car, ball]),
  };
  return { calls, hooks, last: () => calls[calls.length - 1], of: (kind) => calls.filter((c) => c[0] === kind) };
}

/** A small synthetic pack (the real ones are long and checked against the physics elsewhere). */
function makePack(category, n = 3, limit = 4) {
  const shots = [];
  for (let i = 0; i < n; i++) {
    shots.push({ name: `s${i}`, car: { pos: [0, 0, 17], yaw: Math.PI / 2, boost: 50 }, ball: { pos: [0, 1000 + i, 93], vel: [0, 0, 0], angVel: [0, 0, 0] } });
  }
  return { id: `${category}-test`, name: `${category} test`, category, difficulty: 'easy', description: '', timeLimitSeconds: limit, shots };
}

const ground = (over = {}) => ({ x: 0, y: 0, z: 93, vx: 0, vy: 0, vz: 0, ...over });

/** Advance `secs` of ticks with the given ball sample (no goals). */
function run(session, secs, ball = ground()) {
  const n = Math.round(secs / TICK_DT);
  for (let i = 0; i < n; i++) session.tick(TICK_DT, ball);
}

function newSession(category, opts = {}) {
  const rec = recorder();
  const storage = opts.storage ?? new FakeStorage();
  const pack = opts.pack ?? makePack(category, opts.n, opts.limit);
  const s = new TrainingSession(pack, rec.hooks, { storage, now: () => 1234 });
  s.start();
  return { s, rec, storage, pack };
}

// ---- input gate ----------------------------------------------------------------------------

test('hasCarInput: buttons and analog axes beyond the threshold release, camera / tiny values do not', () => {
  const c = emptyControls();
  assert.equal(hasCarInput(c), false);
  c.throttle = 0.05; // a resting trigger
  assert.equal(hasCarInput(c), false);
  for (const k of ['throttle', 'steer', 'pitch', 'yaw', 'roll']) {
    const d = emptyControls();
    d[k] = -0.5;
    assert.equal(hasCarInput(d), true, k);
  }
  for (const k of ['jump', 'boost', 'handbrake']) {
    const d = emptyControls();
    d[k] = true;
    assert.equal(hasCarInput(d), true, k);
  }
});

test('a shot is placed frozen and only the first input releases it (attempt + timer start)', () => {
  const { s, rec } = newSession('shooting');
  assert.deepEqual(rec.calls, [['place', 0, 's0']]);
  assert.equal(s.phase, 'waiting');
  assert.equal(s.frozen, true);
  assert.equal(s.timeLeft, 4);
  run(s, 2);
  s.input(false);
  assert.equal(s.phase, 'waiting', 'no input: still frozen, the timer has not started');
  assert.equal(s.elapsed, 0);
  assert.equal(s.attempts[0], 0);
  s.input(true);
  assert.deepEqual(rec.last(), ['release', 0]);
  assert.equal(s.phase, 'running');
  assert.equal(s.frozen, false);
  assert.equal(s.attempts[0], 1);
  s.input(true);
  assert.equal(rec.of('release').length, 1, 'later input does not release again');
  run(s, 1);
  assert.ok(Math.abs(s.timeLeft - 3) < 1e-6, `timeLeft ${s.timeLeft}`);
});

// ---- shooting / aerial ---------------------------------------------------------------------

test('shooting: an red-goal goal passes and moves on to the next shot after the banner', () => {
  const { s, rec } = newSession('shooting');
  s.input(true);
  run(s, 1);
  assert.equal(s.onGoal(0), true, 'counted: the Game plays the goal effect');
  assert.deepEqual(rec.last(), ['result', 0, true, 'goal']);
  assert.equal(s.phase, 'result');
  assert.equal(s.results[0], 'pass');
  assert.equal(s.onGoal(0), false, 'a second goal in the banner time does not count');
  run(s, RESULT_SECONDS - 0.1);
  assert.equal(s.phase, 'result', 'banner still up');
  run(s, 0.2);
  assert.deepEqual(rec.last(), ['place', 1, 's1']);
  assert.equal(s.index, 1);
  assert.equal(s.phase, 'waiting');
});

test('shooting: own goal and timeout fail and retry the same shot; attempts accumulate', () => {
  const { s, rec } = newSession('shooting');
  s.input(true);
  assert.equal(s.onGoal(1), true);
  assert.deepEqual(rec.last(), ['result', 0, false, 'ownGoal']);
  assert.equal(s.results[0], 'fail');
  run(s, RESULT_SECONDS + 0.05);
  assert.deepEqual(rec.last(), ['place', 0, 's0'], 'retry');
  s.input(true);
  run(s, 3.9);
  assert.equal(s.phase, 'running');
  run(s, 0.2);
  assert.deepEqual(rec.last(), ['result', 0, false, 'timeout']);
  assert.equal(s.attempts[0], 2);
  assert.equal(s.timeLeft, 0);
});

test('aerial: the buzzer with the ball in the air waits for it to land (grace), capped', () => {
  const { s, rec } = newSession('aerial');
  s.input(true);
  run(s, 4.1, ground({ z: 600 }));
  assert.equal(s.phase, 'grace', 'ball airborne at 0:00');
  assert.equal(rec.of('result').length, 0);
  run(s, 1, ground({ z: 300 }));
  assert.equal(s.phase, 'grace');
  assert.equal(s.onGoal(0), true, 'a goal in the grace time still counts');
  assert.deepEqual(rec.last(), ['result', 0, true, 'goal']);

  run(s, RESULT_SECONDS + 0.05); // next shot
  s.input(true);
  run(s, 4.1, ground({ z: 600 }));
  assert.equal(s.phase, 'grace');
  s.tick(TICK_DT, ground()); // landed
  assert.deepEqual(rec.last(), ['result', 1, false, 'timeout']);

  run(s, RESULT_SECONDS + 0.05); // retry shot 1
  s.input(true);
  run(s, 4 + P.TRAINING_GRACE_SECONDS + 0.2, ground({ z: 900 }));
  assert.deepEqual(rec.last(), ['result', 1, false, 'timeout'], 'never lands: the grace is capped');
});

// ---- saving --------------------------------------------------------------------------------

test('saving: a goal conceded fails; a timeout is a save', () => {
  const { s, rec } = newSession('saving');
  s.input(true);
  run(s, 1);
  assert.equal(s.onGoal(1), true);
  assert.deepEqual(rec.last(), ['result', 0, false, 'conceded']);
  run(s, RESULT_SECONDS + 0.05);
  s.input(true);
  run(s, 4.1, ground({ y: -1000, vy: 300 }));
  assert.deepEqual(rec.last(), ['result', 0, true, 'save']);
  assert.equal(s.results[0], 'pass', 'pass is sticky over the earlier fail');
});

test('saving: early save one second after the touch, unless the ball still heads in', () => {
  const { s, rec } = newSession('saving', { limit: 8 });
  s.input(true);
  run(s, 0.5);
  s.onPlayerTouch();
  // Touched, but still rolling into the goal: no save yet.
  run(s, GOALIE_SAVE_SECONDS + 0.2, ground({ y: -4600, vy: -900 }));
  assert.equal(s.phase, 'running');
  // Cleared (moving away): the save comes at once since the touch is old enough.
  s.tick(TICK_DT, ground({ y: -4000, vy: 1200 }));
  assert.deepEqual(rec.last(), ['result', 0, true, 'save']);
  assert.ok(s.elapsed < 2, 'early, long before the 8 s limit');

  run(s, RESULT_SECONDS + 0.05); // next shot
  s.input(true);
  s.onPlayerTouch();
  run(s, GOALIE_SAVE_SECONDS - 0.1, ground({ y: -2000, vy: 800 }));
  assert.equal(s.phase, 'running', 'not before a full second');
  s.onPlayerTouch(); // a later touch restarts the second
  run(s, GOALIE_SAVE_SECONDS - 0.1, ground({ y: -2000, vy: 800 }));
  assert.equal(s.phase, 'running');
  run(s, 0.2, ground({ y: -2000, vy: 800 }));
  assert.deepEqual(rec.last(), ['result', 1, true, 'save']);

  run(s, RESULT_SECONDS + 0.05);
  s.input(true);
  s.onPlayerTouch();
  assert.equal(s.onGoal(0), true, 'cleared into the other goal');
  assert.deepEqual(rec.last(), ['result', 2, true, 'save']);
});

test('saving: a ball still heading for the goal at the buzzer gets the grace too', () => {
  const { s, rec } = newSession('saving');
  s.input(true);
  run(s, 4.1, ground({ y: -4200, vy: -600 }));
  assert.equal(s.phase, 'grace');
  assert.equal(s.onGoal(1), true);
  assert.deepEqual(rec.last(), ['result', 0, false, 'conceded']);
});

test('touches and goals outside an attempt are ignored', () => {
  const { s, rec } = newSession('saving');
  s.onPlayerTouch();
  assert.equal(s.onGoal(1), false, 'waiting: the sim is not even stepping');
  s.input(true);
  run(s, 2, ground({ y: -1000 }));
  assert.equal(rec.of('result').length, 0, 'the touch before the release did not count');
});

// ---- navigation ----------------------------------------------------------------------------

test('reset / next / previous: wrap around, drop the attempt in progress, keep results', () => {
  const { s, rec } = newSession('shooting', { n: 3 });
  s.input(true);
  run(s, 1);
  s.resetShot();
  assert.deepEqual(rec.last(), ['place', 0, 's0']);
  assert.equal(s.phase, 'waiting');
  assert.equal(s.results[0], null, 'an abandoned attempt has no result');
  assert.equal(s.attempts[0], 1, 'but it was an attempt');
  s.prevShot();
  assert.equal(s.index, 2, 'previous from the first wraps to the last');
  s.nextShot();
  assert.equal(s.index, 0);
  s.nextShot();
  assert.equal(s.index, 1);
  s.input(true);
  s.onGoal(0);
  s.nextShot(); // skip the banner
  assert.equal(s.index, 2);
  assert.equal(s.phase, 'waiting');
  assert.equal(s.results[1], 'pass');
  s.goTo(-4);
  assert.equal(s.index, 2, 'goTo wraps negative indices');
});

test('after a pass the session goes to the next shot WITHOUT a result', () => {
  const { s, rec } = newSession('shooting', { n: 4 });
  s.goTo(1);
  s.input(true);
  s.onGoal(0); // shot 1 passed
  run(s, RESULT_SECONDS + 0.05);
  assert.equal(s.index, 2);
  s.goTo(0);
  s.input(true);
  s.onGoal(0); // shot 0 passed: 1 already passed, 2 is next
  run(s, RESULT_SECONDS + 0.05);
  assert.deepEqual(rec.last(), ['place', 2, 's2']);
});

// ---- summary + records ---------------------------------------------------------------------

function playAll(s, outcomes) {
  for (const pass of outcomes) {
    s.input(true);
    if (pass) s.onGoal(0);
    else run(s, s.timeLimit + 0.05);
    if (s.phase === 'result') run(s, RESULT_SECONDS + 0.05);
    // A fail retries the same shot: move on like a player who gives up.
    if (!pass && s.phase === 'waiting') s.nextShot();
  }
}

test('summary: when every shot has a result; best saved; retry pack starts clean', () => {
  const storage = new FakeStorage();
  const { s, rec } = newSession('shooting', { n: 3, storage });
  // pass, fail, pass: the fail (shot 1) retries, the player skips it with next.
  s.input(true);
  s.onGoal(0);
  run(s, RESULT_SECONDS + 0.05);
  assert.equal(s.index, 1);
  s.input(true);
  run(s, 4.05);
  run(s, RESULT_SECONDS + 0.05);
  assert.equal(s.index, 1, 'fail -> retry the same shot');
  s.nextShot();
  s.input(true);
  s.onGoal(0);
  assert.equal(s.phase, 'result');
  run(s, RESULT_SECONDS + 0.05);
  assert.equal(s.phase, 'summary');
  assert.equal(s.frozen, true);
  assert.deepEqual(rec.last(), ['summary', 2, 3, 2, true]);
  assert.deepEqual({ ...s.summary }, { passed: 2, total: 3, best: 2, newBest: true });
  const saved = R.loadTrainingRecords(storage);
  assert.deepEqual(saved['shooting-test'], { best: 2, shots: 3, completedAt: 1234 });
  assert.ok(storage.getItem(R.TRAINING_RECORDS_KEY) !== null);

  // Input does not release anything under the summary; resetShot is ignored there.
  s.input(true);
  s.resetShot();
  assert.equal(s.phase, 'summary');

  s.retryPack();
  assert.deepEqual(rec.last(), ['place', 0, 's0']);
  assert.deepEqual(s.results, [null, null, null]);
  assert.deepEqual(s.attempts, [0, 0, 0]);
  assert.equal(s.summaryShown, false);

  // A worse run keeps the best (no write), a better one replaces it.
  const writes = storage.writes;
  playAll(s, [false, false, false]);
  assert.equal(s.phase, 'summary');
  assert.deepEqual(rec.last(), ['summary', 0, 3, 2, false]);
  assert.equal(storage.writes, writes, 'no write for a worse run');
  s.retryPack();
  playAll(s, [true, true, true]);
  assert.deepEqual(rec.last(), ['summary', 3, 3, 3, true]);
  assert.equal(R.loadTrainingRecords(storage)['shooting-test'].best, 3);
});

test('after the summary, practising shots does not reopen it', () => {
  const { s, rec } = newSession('shooting', { n: 2 });
  playAll(s, [true, true]);
  assert.equal(s.phase, 'summary');
  s.nextShot();
  assert.equal(s.phase, 'waiting');
  s.input(true);
  s.onGoal(0);
  run(s, RESULT_SECONDS + 0.05);
  assert.equal(s.phase, 'waiting', 'next shot, not a second summary');
  assert.equal(rec.of('summary').length, 1);
});

test('storage null: the summary still works and reports a new best', () => {
  const rec = recorder();
  const s = new TrainingSession(makePack('aerial', 1), rec.hooks, { storage: null });
  s.start();
  s.input(true);
  s.onGoal(0);
  run(s, RESULT_SECONDS + 0.05);
  assert.deepEqual(rec.last(), ['summary', 1, 1, 1, true]);
});

test('records: validation drops junk, keeps good entries, never pollutes the prototype', () => {
  const key = R.TRAINING_RECORDS_KEY;
  assert.equal(key, 'turbogol.training.v1');
  assert.deepEqual(R.loadTrainingRecords(new FakeStorage()), {});
  assert.deepEqual(R.loadTrainingRecords(new FakeStorage({ [key]: '{not json' })), {});
  assert.deepEqual(R.loadTrainingRecords(new FakeStorage({ [key]: '[1,2]' })), {});
  assert.deepEqual(R.loadTrainingRecords(null), {});
  const raw = {
    'shooting-easy': { best: 6, shots: 8, completedAt: 99 },
    'saving-medium': { best: 9, shots: 7 }, // best > shots
    'aerial-pro': { best: 2.5, shots: 7 },
    'aerial-easy': { best: 1, shots: 8, completedAt: 'yesterday' },
    __proto__x: { best: 1, shots: 2 },
    'BAD ID': { best: 1, shots: 2 },
  };
  const text = JSON.stringify(raw).replace('"__proto__x"', '"__proto__"');
  const recs = R.loadTrainingRecords(new FakeStorage({ [key]: text }));
  assert.deepEqual(recs, { 'shooting-easy': { best: 6, shots: 8, completedAt: 99 }, 'aerial-easy': { best: 1, shots: 8 } });
  assert.equal(Object.getPrototypeOf(recs), Object.prototype);
  assert.equal({}.best, undefined);
});

test('records: best-of per pack, shot-count change starts over, throwing storage is harmless', () => {
  const st = new FakeStorage();
  let u = R.saveTrainingResult('shooting-easy', 5, 8, 10, st);
  assert.deepEqual(u, { record: { best: 5, shots: 8, completedAt: 10 }, newBest: true });
  u = R.saveTrainingResult('shooting-easy', 5, 8, 20, st);
  assert.equal(u.newBest, false, 'a tie keeps the older record');
  assert.equal(u.record.completedAt, 10);
  u = R.saveTrainingResult('shooting-easy', 7, 8, 30, st);
  assert.deepEqual(u.record, { best: 7, shots: 8, completedAt: 30 });
  u = R.saveTrainingResult('shooting-easy', 3, 6, 40, st);
  assert.deepEqual(u.record, { best: 3, shots: 6, completedAt: 40 }, 'the pack changed length');
  R.saveTrainingResult('saving-medium', 99, 7, 50, st);
  assert.deepEqual(R.loadTrainingRecords(st), {
    'shooting-easy': { best: 3, shots: 6, completedAt: 40 },
    'saving-medium': { best: 7, shots: 7, completedAt: 50 },
  });
  const broken = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('QuotaExceeded');
    },
  };
  assert.deepEqual(R.loadTrainingRecords(broken), {});
  assert.equal(R.saveTrainingResult('shooting-medium', 2, 7, 1, broken).newBest, true);
  // No localStorage in node: the defaults must not throw either.
  assert.deepEqual(R.loadTrainingRecords(), {});
});

// ---- free play -----------------------------------------------------------------------------

test('free play: never frozen, goal -> banner hook, ball back at the centre after the pause', () => {
  const rec = recorder();
  const s = new TrainingSession(null, rec.hooks, { storage: null });
  s.start();
  assert.deepEqual(rec.calls, [['fpReset', true, true]]);
  assert.equal(s.isFreeplay, true);
  assert.equal(s.phase, 'freeplay');
  assert.equal(s.frozen, false);
  s.input(true);
  assert.equal(rec.calls.length, 1, 'no release in free play');
  assert.equal(s.onGoal(1), true);
  assert.deepEqual(rec.last(), ['fpGoal', 1]);
  assert.equal(s.onGoal(0), false, 'no second goal during the pause');
  run(s, FREEPLAY_GOAL_PAUSE_SECONDS - 0.1);
  assert.deepEqual(rec.last(), ['fpGoal', 1]);
  run(s, 0.2);
  assert.deepEqual(rec.last(), ['fpReset', false, true]);
  assert.equal(s.onGoal(0), true, 'the next goal counts again');
  s.resetBall(); // early reset ends the pause
  assert.deepEqual(rec.last(), ['fpReset', false, true]);
  const n = rec.calls.length;
  run(s, FREEPLAY_GOAL_PAUSE_SECONDS + 0.1);
  assert.equal(rec.calls.length, n, 'the pending goal reset was cancelled');
  s.resetCar();
  assert.deepEqual(rec.last(), ['fpReset', true, false]);
  s.resetShot(); // the reset key in free play = reset ball
  assert.deepEqual(rec.last(), ['fpReset', false, true]);
  s.nextShot();
  s.prevShot();
  s.retryPack();
  assert.deepEqual(rec.last(), ['fpReset', false, true], 'pack actions do nothing in free play');
});

test('the real packs drive the session: 9 packs, 6-8 shots, the summary covers every shot', () => {
  assert.equal(P.TRAINING_PACKS.length, 9);
  const pack = P.packById('saving-hard');
  const { s, rec } = newSession('saving', { pack });
  assert.equal(s.shotCount, pack.shots.length);
  for (let i = 0; i < pack.shots.length; i++) {
    s.input(true);
    run(s, pack.timeLimitSeconds + 0.05, ground({ y: -1000, vy: 500 }));
    run(s, RESULT_SECONDS + 0.05);
  }
  assert.equal(s.phase, 'summary');
  assert.deepEqual(rec.last().slice(0, 3), ['summary', pack.shots.length, pack.shots.length]);
});
