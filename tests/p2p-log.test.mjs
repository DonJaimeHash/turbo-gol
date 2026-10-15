// P2PLog (src/net/p2p/DebugLog.ts): the 256-entry debug ring behind window.__game.p2p.log.
//   node --test tests/p2p-log.test.mjs
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

const { P2PLog, P2P_LOG_SIZE } = await import('../src/net/p2p/DebugLog.ts');

test('push / entry / lines: oldest first, formatted time in seconds, sequence numbers, empty detail omitted', () => {
  let t = 1234.6;
  const log = new P2PLog(() => t, 4);
  assert.equal(P2P_LOG_SIZE, 256);
  assert.equal(log.length, 0);
  log.push('a', 'one');
  t = 2000;
  log.push('b');
  assert.equal(log.length, 2);
  assert.equal(log.total, 2);
  const e = { seq: -1, at: 0, event: '', detail: '' };
  assert.equal(log.entry(0, e), true);
  assert.deepEqual(e, { seq: 0, at: 1234.6, event: 'a', detail: 'one' });
  assert.equal(log.entry(1, e), true);
  assert.deepEqual(e, { seq: 1, at: 2000, event: 'b', detail: '' });
  assert.equal(log.entry(2, e), false);
  assert.deepEqual(log.lines(), ['1.235 #0 a one', '2.000 #1 b']);
  assert.equal(log.text(), '1.235 #0 a one\n2.000 #1 b');
  assert.deepEqual(log.toJSON(), log.lines());
  assert.equal(log.eventAt(1), 'b');
  assert.equal(log.eventAt(5), '');
  assert.ok(log.has('a') && !log.has('zzz'));
});

test('the ring keeps the newest `size` entries and the sequence keeps counting across wraps', () => {
  const log = new P2PLog(() => 0, 4);
  for (let i = 0; i < 10; i++) log.push('e' + i, String(i));
  assert.equal(log.length, 4);
  assert.equal(log.total, 10);
  assert.deepEqual(log.lines(), ['0.000 #6 e6 6', '0.000 #7 e7 7', '0.000 #8 e8 8', '0.000 #9 e9 9']);
  assert.equal(log.has('e5'), false, 'forgotten');
  log.clear();
  assert.equal(log.length, 0);
  assert.deepEqual(log.lines(), []);
  log.push('after');
  assert.deepEqual(log.lines(), ['0.000 #10 after']);
});
