// ENTRENAMIENTO's decisions (src/ui/screens/trainingModel.ts, plan PR 13): the difficulty marks by
// shape, the pack sheet's first focus, the summary's NEXT LEVEL and the device the texts speak to.
// Run: node --test tests/training-screen.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const M = await import('../src/ui/screens/trainingModel.ts');
// The nine packs as src/game/trainingPacks.ts lists them (its module needs the sim's constants).
const TRAINING_DIFFICULTIES = ['easy', 'medium', 'hard'];
const SHOTS = { easy: 6, medium: 7, hard: 8 };
const TRAINING_PACKS = ['shooting', 'saving', 'aerial'].flatMap((category) => TRAINING_DIFFICULTIES.map((difficulty) => ({ id: `${category}-${difficulty}`, category, difficulty, shots: Array.from({ length: SHOTS[difficulty] }, () => ({})) })));

const shooting = TRAINING_PACKS.filter((p) => p.category === 'shooting');

test('a mark: every shot in one run is passed (✓), a run is played, no record (or an older pack length) is none', () => {
  const p = shooting[0];
  const n = p.shots.length;
  assert.equal(M.markOf(p, undefined).state, 'none');
  assert.equal(M.markOf(p, { best: n, shots: n }).state, 'done');
  assert.equal(M.markOf(p, { best: n - 1, shots: n }).state, 'tried');
  assert.equal(M.markOf(p, { best: 0, shots: n }).state, 'tried', 'played with nothing passed is still played');
  assert.equal(M.markOf(p, { best: n, shots: n + 1 }).state, 'none', 'the pack changed length: it starts over');
  assert.equal(M.markOf(p, { best: 3, shots: n }).best, 3);
});

test("a category's three marks, easy to hard; the sheet starts on the first not passed", () => {
  const n = (i) => shooting[i].shots.length;
  const records = { [shooting[0].id]: { best: n(0), shots: n(0) }, [shooting[1].id]: { best: 1, shots: n(1) } };
  const marks = M.categoryMarks(TRAINING_PACKS, records, 'shooting');
  assert.deepEqual(marks.map((m) => m.pack.difficulty), ['easy', 'medium', 'hard']);
  assert.deepEqual(marks.map((m) => m.state), ['done', 'tried', 'none']);
  assert.equal(M.firstOpen(marks), 1);
  assert.equal(M.firstOpen(M.categoryMarks(TRAINING_PACKS, {}, 'aerial')), 0);
  const all = Object.fromEntries(shooting.map((p) => [p.id, { best: p.shots.length, shots: p.shots.length }]));
  assert.equal(M.firstOpen(M.categoryMarks(TRAINING_PACKS, all, 'shooting')), 2, 'all passed: the hardest');
});

test('NEXT LEVEL: the same category one step harder; none after Expert', () => {
  assert.equal(M.nextLevel(TRAINING_PACKS, 'shooting-easy', TRAINING_DIFFICULTIES)?.id, 'shooting-medium');
  assert.equal(M.nextLevel(TRAINING_PACKS, 'saving-medium', TRAINING_DIFFICULTIES)?.id, 'saving-hard');
  assert.equal(M.nextLevel(TRAINING_PACKS, 'aerial-hard', TRAINING_DIFFICULTIES), null);
  assert.equal(M.nextLevel(TRAINING_PACKS, 'freeplay', TRAINING_DIFFICULTIES), null);
});

test('the device the texts speak to: a controller (a TV remote plays with one), a finger, else keyboard and mouse', () => {
  assert.equal(M.trainDevice('pad'), 'pad');
  assert.equal(M.trainDevice('remote'), 'pad');
  assert.equal(M.trainDevice('touch'), 'touch');
  assert.equal(M.trainDevice('keyboard'), 'kbm');
  assert.equal(M.trainDevice('mouse'), 'kbm');
});
