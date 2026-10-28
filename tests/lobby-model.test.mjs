// The Salas' pure decisions (src/ui/screens/lobbyModel.ts), the online outcomes (src/net/outcome.ts)
// and "back to your match" (src/game/rejoinStore.ts), plan PR 12. Run: node --test tests/lobby-model.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (relative && err && err.code === 'ERR_MODULE_NOT_FOUND' && !/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + '.ts', context);
      throw err;
    }
  },
});

const M = await import('../src/ui/screens/lobbyModel.ts');
const O = await import('../src/net/outcome.ts');
const R = await import('../src/game/rejoinStore.ts');

test('the code: the server alphabet only (no I, O, 0, 1), six at most, spaced in the middle', () => {
  assert.equal(M.CODE_ALPHABET.length, 32);
  for (const ch of 'IO01') assert.ok(!M.CODE_ALPHABET.includes(ch));
  assert.equal(M.cleanCode(' abc-234 '), 'ABC234');
  assert.equal(M.cleanCode('io01abc2345678'), 'ABC234', 'the ambiguous ones never get in; the seventh is cut');
  assert.equal(M.fullCode('abc23'), null);
  assert.equal(M.fullCode('ABC 234'), 'ABC234');
  assert.equal(M.spacedCode('ABC234'), 'ABC 234');
  assert.equal(M.spacedCode('ABC'), 'ABC');
});

test("the remote's ▲ ▼ on a cell: the alphabet round; past the last typed a new cell starts", () => {
  assert.equal(M.cycleCell('', 0, 1), 'A');
  assert.equal(M.cycleCell('', 0, -1), '9');
  assert.equal(M.cycleCell('A', 0, 1), 'B');
  assert.equal(M.cycleCell('A', 0, -1), '9', 'round');
  assert.equal(M.cycleCell('H', 0, 1), 'J', 'no I');
  assert.equal(M.cycleCell('N', 0, 1), 'P', 'no O');
  assert.equal(M.cycleCell('9', 0, 1), 'A');
  assert.equal(M.cycleCell('AB', 2, 1), 'ABA', 'the next cell');
  assert.equal(M.cycleCell('AB', 5, 1), 'ABA', 'never a gap');
  assert.equal(M.cycleCell('ABCDEF', 9, 1), 'ABCDEG', 'six cells: the last one');
});

test('the join link: built on the origin, read among other flags, taken out of the hash', () => {
  assert.equal(M.joinLink('https://turbo-gol.com', 'ABC234'), 'https://turbo-gol.com/#sala=ABC234');
  assert.equal(M.joinLink('http://127.0.0.1:5290/', 'ABC234'), 'http://127.0.0.1:5290/#sala=ABC234');
  assert.equal(M.shortLink('https://turbo-gol.com/#sala=ABC234'), 'turbo-gol.com/#sala=ABC234');
  assert.equal(M.linkCode('#sala=ABC234'), 'ABC234');
  assert.equal(M.linkCode('#tv&sala=abc-234'), 'ABC234');
  assert.equal(M.linkCode('#sala=ABC'), null, 'not a code');
  assert.equal(M.linkCode('#salami=ABC234'), null);
  assert.equal(M.linkCode(''), null);
  assert.equal(M.withoutLink('#tv&sala=ABC234&superlow'), '#tv&superlow');
  assert.equal(M.withoutLink('#sala=ABC234'), '');
});

test('a broken join link (a cut or hand-edited escape) is no code, never a throw, and still goes', () => {
  for (const hash of ['#sala=%', '#sala=%E0%A4%A', '#tv&sala=%zz', '#sala=AB%E0']) {
    assert.equal(M.linkCode(hash), null, hash);
    assert.equal(M.hasLink(hash), true, hash);
  }
  assert.equal(M.withoutLink('#tv&sala=%zz'), '#tv');
  assert.equal(M.hasLink('#tv&superlow'), false);
  assert.equal(M.hasLink('#salami=ABC234'), false);
  assert.equal(M.linkCode('#sala=ABC%20234'), 'ABC234', 'a good escape still decodes');
});

test("a new lobby's format: the last lobby's, else Casual's single pick, else 2v2; a row's state", () => {
  assert.equal(M.lobbyFormat({ lobbyMode: '3v3', casualModes: ['1v1'] }), '3v3');
  assert.equal(M.lobbyFormat({ lobbyMode: null, casualModes: ['1v1'] }), '1v1');
  assert.equal(M.lobbyFormat({ lobbyMode: null, casualModes: ['1v1', '2v2'] }), '2v2');
  assert.equal(M.rowState({ inGame: false, players: 1, max: 4 }), 'open');
  assert.equal(M.rowState({ inGame: false, players: 4, max: 4 }), 'full');
  assert.equal(M.rowState({ inGame: true, players: 4, max: 4 }), 'inMatch');
});

test('how COMPARTIR shares: a TV draws the QR, a touch screen with navigator.share shares, else the link is copied', () => {
  assert.equal(M.shareWay({ tv: true, touch: false, canShare: true }), 'qr');
  assert.equal(M.shareWay({ tv: false, touch: true, canShare: true }), 'share');
  assert.equal(M.shareWay({ tv: false, touch: true, canShare: false }), 'copy');
  assert.equal(M.shareWay({ tv: false, touch: false, canShare: true }), 'copy', 'a PC with a share sheet still copies');
});

test('every online failure has one of the five outcomes', () => {
  const cases = [
    [{ code: 'network', status: 0, serverCode: '' }, 'retry'],
    [{ code: 'http', status: 500, serverCode: 'internal' }, 'retry'],
    [{ code: 'http', status: 429, serverCode: 'rate_limited' }, 'wait'],
    [{ code: 'http', status: 503, serverCode: 'capacity' }, 'wait'],
    [{ code: 'http', status: 503, serverCode: 'matchmaking_off' }, 'wait'],
    [{ code: 'http', status: 426, serverCode: 'reload_required' }, 'reload'],
    [{ code: 'protocol', status: 0, serverCode: '' }, 'reload'],
    [{ code: 'no_lobby', status: 404 }, 'gone'],
    [{ code: 'kicked', status: 403 }, 'gone'],
    [{ code: 'full', status: 409 }, 'gone'],
    [{ code: 'http', status: 410, serverCode: 'match_over' }, 'gone'],
    [{ code: 'cancelled_match' }, 'requeue'],
    [null, 'retry'],
  ];
  for (const [f, want] of cases) assert.equal(O.outcomeOf(f), want, JSON.stringify(f));
  assert.deepEqual(Object.keys(O.OUTCOME_ACTION).sort(), ['gone', 'reload', 'requeue', 'retry', 'wait']);
});

class MemStore {
  constructor() {
    this.m = new Map();
  }
  getItem(k) {
    return this.m.has(k) ? this.m.get(k) : null;
  }
  setItem(k, v) {
    this.m.set(k, String(v));
  }
  removeItem(k) {
    this.m.delete(k);
  }
}

test('back to your match: kept while the match can still run, then forgotten', () => {
  const s = new MemStore();
  const now = 1_000_000;
  const rec = { matchId: 'a'.repeat(64), kind: 'ranked', modes: ['2v2'], endsAt: now + 120_000, savedAt: now };
  R.saveRejoin(rec, s);
  assert.deepEqual(R.readRejoin(now + 1000, s), rec);
  assert.equal(R.rejoinLeftMs(rec, now + 20_000), 100_000);
  assert.ok(R.readRejoin(now + 120_000 + R.REJOIN_OVERTIME_MS - 1, s), 'overtime may still run');
  assert.equal(R.readRejoin(now + 120_000 + R.REJOIN_OVERTIME_MS, s), null);
  assert.equal(s.getItem(R.REJOIN_KEY), null, 'a stale record is removed');
  R.saveRejoin({ ...rec, endsAt: null }, s);
  assert.ok(R.readRejoin(now + R.REJOIN_OPEN_MS - 1, s), 'unknown end: offered for a while');
  assert.equal(R.readRejoin(now + R.REJOIN_OPEN_MS, s), null);
  s.setItem(R.REJOIN_KEY, '{bad');
  assert.equal(R.readRejoin(now, s), null);
  R.saveRejoin(rec, s);
  R.clearRejoin(s);
  assert.equal(R.readRejoin(now, s), null);
  assert.equal(R.readRejoin(now, null), null, 'no storage: nothing');
});
