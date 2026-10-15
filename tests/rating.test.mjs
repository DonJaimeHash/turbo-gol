// Ranked rating (src/net/rating.ts): the Weng-Lin Bradley-Terry update against OpenSkill's own
// reference vector, the abandon rules, tiers and the per-game magnitudes the menus promise.
//   node --test tests/rating.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RATING,
  PLACEMENT_MATCHES,
  TIERS,
  abandonBanMs,
  mmrOf,
  newRating,
  rateRankedMatch,
  rateTeams,
  tierOf,
  tierProgress,
} from '../src/net/rating.ts';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('rateTeams reproduces openskill.js BT-full 1v1 (tau 0): winner 27.6352, loser 22.3648, sigma 8.0655', () => {
  const [[a], [b]] = rateTeams([[newRating()], [newRating()]], [0, 1], 0);
  close(a.mu, 27.63523138347365);
  close(b.mu, 22.36476861652635);
  close(a.sigma, 8.065506316323548);
  close(b.sigma, 8.065506316323548);
});

test('rateTeams: symmetric, zero-sum for equal teams, a draw between equals moves no mu, inputs untouched', () => {
  const t0 = [newRating(), newRating()];
  const t1 = [newRating(), newRating()];
  const [w, l] = rateTeams([t0, t1], [0, 1]);
  close(w[0].mu - 25, 25 - l[0].mu);
  close(w[0].mu, w[1].mu);
  assert.deepEqual(t0[0], newRating(), 'not mutated');
  const [d0, d1] = rateTeams([[newRating()], [newRating()]], [0, 0]);
  close(d0[0].mu, 25);
  close(d1[0].mu, 25);
  assert.ok(d0[0].sigma < RATING.sigma, 'a draw is information too');
  assert.throws(() => rateTeams([[newRating()]], [0]));
  assert.throws(() => rateTeams([[], [newRating()]], [0, 1]));
});

test('upsets move more than expected results; the uncertain player of a team moves more', () => {
  const strong = { mu: 35, sigma: 3 };
  const weak = { mu: 20, sigma: 3 };
  const [[sw]] = rateTeams([[strong], [weak]], [0, 1]);
  const [[su]] = rateTeams([[strong], [weak]], [1, 0]);
  assert.ok(Math.abs(su.mu - strong.mu) > 3 * Math.abs(sw.mu - strong.mu), 'losing to a weaker player costs far more than beating them earns');
  const vet = { mu: 25, sigma: 2 };
  const rookie = newRating();
  const [[v, r]] = rateTeams([[vet, rookie], [newRating(), newRating()]], [0, 1]);
  assert.ok(r.mu - rookie.mu > v.mu - vet.mu, 'sigma^2 share');
});

test('magnitudes: ~100 MMR per placement game, ~10 per game once settled (1v1 and 2v2)', () => {
  let a = newRating();
  let b = newRating();
  const [[first]] = rateTeams([[a], [b]], [0, 1]);
  const d0 = mmrOf(first.mu) - mmrOf(a.mu);
  assert.ok(d0 > 80 && d0 < 130, `first game ${d0}`);
  for (let g = 0; g < 500; g++) [[a], [b]] = rateTeams([[a], [b]], g % 2 === 0 ? [0, 1] : [1, 0]);
  const [[n]] = rateTeams([[a], [b]], [0, 1]);
  const d = mmrOf(n.mu) - mmrOf(a.mu);
  assert.ok(d >= 7 && d <= 14, `settled 1v1 ${d} (sigma ${a.sigma.toFixed(2)})`);
  let t = [newRating(), newRating()];
  let u = [newRating(), newRating()];
  for (let g = 0; g < 500; g++) [t, u] = rateTeams([t, u], g % 2 === 0 ? [0, 1] : [1, 0]);
  const [x] = rateTeams([t, u], [0, 1]);
  const d2 = mmrOf(x[0].mu) - mmrOf(t[0].mu);
  assert.ok(d2 >= 6 && d2 <= 14, `settled 2v2 ${d2}`);
});

test('rateRankedMatch: a leaver loses even when the team won; a leaver teammate who lost loses half; opponents get the real result', () => {
  const P = (id, team, left = false) => ({ id, team, left, rating: newRating() });
  const lostWithLeaver = rateRankedMatch([P('a', 0, true), P('b', 0), P('c', 1), P('d', 1)], 1);
  const normal = rateRankedMatch([P('a', 0), P('b', 0), P('c', 1), P('d', 1)], 1);
  const by = (r, id) => r.find((x) => x.id === id);
  assert.equal(by(lostWithLeaver, 'a').outcome, 'loss');
  assert.ok(by(lostWithLeaver, 'a').after.mu < 25);
  close(by(lostWithLeaver, 'b').after.mu - 25, (by(normal, 'b').after.mu - 25) / 2);
  close(by(lostWithLeaver, 'c').after.mu, by(normal, 'c').after.mu);
  const wonButLeft = rateRankedMatch([P('a', 0, true), P('b', 0), P('c', 1), P('d', 1)], 0);
  assert.equal(by(wonButLeft, 'a').outcome, 'loss', 'leaving never pays');
  assert.ok(by(wonButLeft, 'a').after.mu < 25);
  assert.equal(by(wonButLeft, 'b').outcome, 'win');
  assert.ok(by(wonButLeft, 'b').after.mu > 25);
  const draw = rateRankedMatch([P('a', 0), P('c', 1)], -1);
  assert.equal(draw[0].outcome, 'draw');
  assert.throws(() => rateRankedMatch([P('a', 0), P('b', 0)], 0), 'both teams need a player');
});

test('tiers: ordered, contiguous, start 1000 = Oro II, extremes; progress within a tier', () => {
  for (let i = 1; i < TIERS.length; i++) assert.ok(TIERS[i].min > TIERS[i - 1].min);
  assert.equal(TIERS.length, 22);
  assert.equal(tierOf(mmrOf(RATING.mu)).id, 'gold-2');
  assert.equal(tierOf(-500).id, 'bronze-1');
  assert.equal(tierOf(5000).id, 'legend');
  assert.equal(tierOf(1750).name, 'Maestro I');
  assert.equal(tierProgress(1000), 0);
  close(tierProgress(1030), 0.5);
  assert.equal(tierProgress(3000), 1);
  assert.equal(PLACEMENT_MATCHES, 5);
});

test('abandon bans escalate 5 min, 15 min, 1 h, 24 h', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(abandonBanMs), [0, 300_000, 900_000, 3_600_000, 86_400_000, 86_400_000]);
});
