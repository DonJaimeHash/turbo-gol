// The FINAL's decisions (plan PR 7; src/ui/screens/match/finalModel.ts): who a goal is credited
// to (the scoring team's last toucher of the play, read from the state buffer the client already
// has), the MVP, the outcome, what PLAY AGAIN and CHANGE MODE do for each kind of match, and the
// rank card from the ranked result; the copy the owner chose.
//   node --test tests/final-model.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (!specifier.startsWith('.') || /\.[cm]?ts$/.test(specifier)) throw err;
      return nextResolve(specifier.replace(/\.js$/, '') + '.ts', context);
    }
  },
});

const F = await import('../src/ui/screens/match/finalModel.ts');
const T = await import('../src/sim/types.ts');
const { DEFAULT_PREFS } = await import('../src/ui/prefs.ts');
const en = (await import('../src/locales/en.ts')).default;
const es = (await import('../src/locales/es.ts')).default;

/** A state buffer with `cars` as [team, lastBallHitTick]. */
function buffer(cars) {
  const buf = new Float32Array(T.STATE_BUFFER_FLOATS);
  buf[T.H_NUM_CARS] = cars.length;
  cars.forEach(([team, tick], slot) => {
    const off = T.CARS_OFFSET + slot * T.CAR_STRIDE;
    buf[off + T.C_TEAM] = team;
    buf[off + T.C_BALL_HIT_TICK] = tick;
  });
  return buf;
}

test('goalScorer: the scoring team\'s latest toucher since the kickoff; an opponent\'s later touch (an own goal) does not take it', () => {
  // 2v2: blue slots 0, 1; red slots 2, 3.
  const buf = buffer([
    [0, 900],
    [0, 1200],
    [1, 1300],
    [1, -1],
  ]);
  assert.equal(F.goalScorer(buf, 0, 1000), 1, 'blue scores: slot 1 touched last for blue');
  assert.equal(F.goalScorer(buf, 1, 1000), 2, 'red scores: slot 2');
  assert.equal(F.goalScorer(buf, 0, 1250), -1, 'no blue touch in this play: nobody credited');
  assert.equal(F.goalScorer(buf, 0, 0), 1);
  assert.equal(F.goalScorer(buffer([]), 0, 0), -1);
});

const p = (name, team, goals, you = false, bot = false) => ({ name, team, goals, you, bot });

test('the MVP: the winning team\'s top scorer, only when one stands alone; a draw has none', () => {
  const players = [p('Nico', 0, 2, true), p('Ana', 0, 1), p('Leo', 1, 1), p('Vale', 1, 0)];
  assert.equal(F.pickMvp(players, 0), 0);
  assert.equal(F.pickMvp(players, 1), 2);
  assert.equal(F.pickMvp(players, null), -1);
  assert.equal(F.pickMvp([p('A', 0, 1), p('B', 0, 1)], 0), -1, 'a tie: no MVP');
  assert.equal(F.pickMvp([p('A', 0, 0), p('B', 1, 3)], 0), -1, 'the winners scored nothing (a forfeit)');
});

test('outcome and rows: from the player\'s side; the player\'s row first in its team', () => {
  assert.equal(F.finalOutcome({ winner: 0, team: 0 }), 'win');
  assert.equal(F.finalOutcome({ winner: 0, team: 1 }), 'loss');
  assert.equal(F.finalOutcome({ winner: null, team: 1 }), 'draw');
  const rows = F.finalRows([p('Ana', 0, 1), p('Leo', 1, 1), p('Nico', 0, 2, true)], 0);
  assert.deepEqual(rows.map((r) => r.name), ['Nico', 'Ana']);
});

test('PLAY AGAIN repeats the same queue in one press (the kind\'s playlists, as Inicio\'s hero would), restarts against the AI, goes back to the lobby', () => {
  const prefs = { ...DEFAULT_PREFS, casualModes: ['1v1', '3v3'], rankedModes: ['2v2'], region: 'EU', net: 'server', lastQueue: 'ranked' };
  assert.deepEqual(F.againAction('casual', prefs), { kind: 'search', queue: { kind: 'casual', modes: ['1v1', '3v3'], region: 'EU', net: 'server' } });
  assert.deepEqual(F.againAction('ranked', prefs), { kind: 'search', queue: { kind: 'ranked', modes: ['2v2'], region: 'EU', net: 'server' } });
  assert.deepEqual(F.againAction('ai', prefs), { kind: 'restart' });
  assert.deepEqual(F.againAction('lobby', prefs), { kind: 'lobby' });
  // CHANGE MODE: that kind's screen on this base.
  assert.deepEqual(['casual', 'ranked', 'ai', 'lobby'].map(F.changeScreen), ['casual', 'ranked', 'friendly', 'custom']);
});

test('the rank card: waiting, pending, cancelled, or the change inside the tier the player is in now', () => {
  assert.deepEqual(F.rankCard(null), { state: 'waiting' });
  assert.deepEqual(F.rankCard({ status: 'pending' }), { state: 'pending' });
  assert.deepEqual(F.rankCard({ status: 'cancelled', reason: 'unverified' }), { state: 'cancelled', reason: 'unverified' });
  const done = (before, after, placementLeft = 0) => F.rankCard({ status: 'done', playlist: '2v2', outcome: 'win', left: false, mmrBefore: before, mmrAfter: after, tierBefore: null, tierAfter: 'gold-3', placementLeft, banUntil: 0 });
  const up = done(1065, 1083);
  assert.equal(up.delta, 18);
  assert.equal(up.mmr, 1083);
  assert.equal(up.nextId, 'platinum-1');
  assert.equal(up.toNext, 1120 - 1083);
  assert.ok(up.from < up.to && up.from > 0, 'the gain sits on the bar after what was there');
  const promoted = done(1050, 1070);
  assert.equal(promoted.from, 0, 'a promotion starts the new tier\'s bar at 0');
  const down = done(1083, 1070);
  assert.equal(down.delta, -13);
  assert.ok(down.from < down.to);
});

test('the copy: the owner\'s words (2V2 never PAREJAS, JUGAR OTRA VEZ, the no-show line), English and Spanish', () => {
  assert.equal(es['final.again'], 'JUGAR OTRA VEZ');
  assert.equal(es['final.win'], 'VICTORIA');
  assert.equal(es['final.loss'], 'DERROTA');
  assert.equal(es['final.draw'], 'EMPATE');
  assert.equal(es['final.change'], 'CAMBIAR MODO');
  assert.equal(es['final.menu'], 'MENÚ');
  assert.equal(es['final.noShow'], 'Un jugador no se presentó · de vuelta en la cola');
  assert.equal(es['found.title'], 'PARTIDO ENCONTRADO');
  assert.equal(es['pause.live'], 'PARTIDO EN JUEGO');
  assert.equal(es['hud.goal'], '¡GOOOL!');
  for (const msgs of [en, es]) for (const [k, v] of Object.entries(msgs)) if (k.startsWith('final.') || k.startsWith('found.')) assert.doesNotMatch(JSON.stringify(v), /PAREJAS|Parejas|PAIRS|Pairs/, k);
});
