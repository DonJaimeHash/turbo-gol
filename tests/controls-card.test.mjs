// The controls card (src/render/controlsCard.ts, node --test tests/controls-card.test.mjs): its rows
// come from the LIVE bindings of the device in use (keyboard + mouse, controller; touch gets none),
// with mouse buttons in words and a stick's two directions as one cap; the big card shows during the
// kickoff countdown of the first CARD_FIRST_MATCHES matches (counted in storage when it shows) and
// in free play until the car moves, then a slim strip for CARD_STRIP_SECONDS of play.
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

const C = await import('../src/render/controlsCard.ts');
const B = await import('../src/input/bindings.ts');
const { STORAGE_PREFIX } = await import('../src/brand.ts');
const { ControlsCardPlan, controlsCardRows, CARD_FIRST_MATCHES, CARD_STRIP_SECONDS, CARD_SEEN_KEY } = C;

/** A binding lookup over plain profiles, like Input.getBinding over the live settings. */
const lookup = (kbm, pad = B.DEFAULT_PAD) => (action, device) => (device === 'kbm' ? kbm : pad)[action] ?? null;
const flat = (rows) => rows.map((r) => [r.label, r.keys.map((k) => (k.kind === 'mouse' ? `mouse${k.button}:${k.label}` : `${k.kind}:${k.label}`))]);

test('keyboard + mouse rows from the default layout: W S, A D, mouse buttons in words, Space', () => {
  assert.deepEqual(flat(controlsCardRows('kbm', lookup(B.DEFAULT_KBM))), [
    ['Drive', ['key:W', 'key:S']],
    ['Steer', ['key:A', 'key:D']],
    ['Jump', ['mouse2:Right click']],
    ['Boost', ['mouse0:Left click']],
    ['Ball cam', ['key:Space']],
  ]);
  assert.deepEqual(flat(controlsCardRows('kbm', lookup(B.KEYBOARD_ONLY_KBM))).slice(2), [
    ['Jump', ['key:Space']],
    ['Boost', ['key:L Shift']],
    ['Ball cam', ['key:C']],
  ]);
});

test('controller rows: the triggers, the left stick as one cap, A, B, Y', () => {
  assert.deepEqual(flat(controlsCardRows('pad', lookup(B.DEFAULT_KBM))), [
    ['Drive', ['pad:RT', 'pad:LT']],
    ['Steer', ['pad:L stick']],
    ['Jump', ['pad:A']],
    ['Boost', ['pad:B']],
    ['Ball cam', ['pad:Y']],
  ]);
});

test('the live bindings: a rebind shows, an unbound action is left out (and an empty row with it)', () => {
  const kbm = { ...B.DEFAULT_KBM, boost: { kind: 'key', code: 'KeyF' }, ballCam: null, reverse: null, jump: { kind: 'mouse', button: 3 } };
  const rows = flat(controlsCardRows('kbm', lookup(kbm)));
  assert.deepEqual(rows, [
    ['Drive', ['key:W']],
    ['Steer', ['key:A', 'key:D']],
    ['Jump', ['mouse3:Mouse 4']],
    ['Boost', ['key:F']],
  ]);
  const pad = { ...B.DEFAULT_PAD, steerRight: { kind: 'gpAxis', index: 2, sign: 1 } };
  assert.deepEqual(flat(controlsCardRows('pad', lookup(B.DEFAULT_KBM, pad)))[1], ['Steer', ['pad:L stick ←', 'pad:R stick →']], 'two sticks stay two caps');
});

/** An in-memory seen counter, like localStorage under CARD_SEEN_KEY. */
function store(n = 0) {
  const s = { n, writes: [] };
  s.read = () => s.n;
  s.write = (v) => {
    s.n = v;
    s.writes.push(v);
  };
  return s;
}

test('the first matches: big during the first countdown, a strip from GO for a minute of play, counted when it shows', () => {
  assert.equal(CARD_FIRST_MATCHES, 3);
  assert.equal(CARD_STRIP_SECONDS, 60);
  assert.ok(CARD_SEEN_KEY.startsWith(STORAGE_PREFIX), 'under the brand prefix');
  const s = store();
  const plan = new ControlsCardPlan(s);
  assert.equal(plan.view, 'off');
  plan.countdown();
  assert.equal(plan.view, 'off', 'not armed: no menus came before');
  for (let m = 1; m <= CARD_FIRST_MATCHES; m++) {
    plan.arm(); // the menus
    assert.equal(plan.view, 'off');
    plan.countdown(); // 3
    assert.equal(plan.view, 'full');
    assert.equal(plan.match, m);
    assert.deepEqual(s.writes.at(-1), m, 'stored as it shows (a match left in the countdown counts)');
    plan.countdown(); // 2, 1: the same card
    plan.tick(1);
    assert.equal(plan.view, 'full', 'the countdown is not play time');
    plan.go();
    assert.equal(plan.view, 'strip');
    plan.tick(CARD_STRIP_SECONDS - 1);
    assert.equal(plan.view, 'strip');
    plan.tick(0); // paused / frozen: the Game passes 0
    plan.tick(-5);
    assert.equal(plan.view, 'strip');
    // A goal: the next kickoff's countdown brings nothing back.
    plan.countdown();
    plan.go();
    plan.tick(1.01);
    assert.equal(plan.view, 'off');
    plan.countdown();
    assert.equal(plan.view, 'off');
  }
  assert.equal(plan.seen, CARD_FIRST_MATCHES);
  plan.arm();
  plan.countdown();
  assert.equal(plan.view, 'off', 'the fourth match: no card');
  assert.equal(s.n, CARD_FIRST_MATCHES, 'nothing more stored');
});

test('the count survives the page: a player with two matches seen gets one more card', () => {
  const s = store(2);
  const plan = new ControlsCardPlan(s);
  plan.arm();
  plan.countdown();
  assert.equal(plan.view, 'full');
  assert.equal(plan.match, 3);
  plan.arm();
  plan.countdown();
  assert.equal(plan.view, 'off');
});

test('free play: big from the start whatever the count, a strip once the car moves; clear and the menus end it', () => {
  const plan = new ControlsCardPlan(store(CARD_FIRST_MATCHES));
  plan.freePlay();
  assert.equal(plan.view, 'full');
  assert.equal(plan.match, 0);
  plan.go(); // no countdown in free play: GO does nothing
  plan.tick(30);
  assert.equal(plan.view, 'full', 'waits for the car');
  plan.drove();
  assert.equal(plan.view, 'strip');
  plan.drove();
  plan.tick(CARD_STRIP_SECONDS);
  assert.equal(plan.view, 'off');
  plan.freePlay();
  plan.clear(); // a pack, the whistle
  assert.equal(plan.view, 'off');
  plan.countdown();
  assert.equal(plan.view, 'off', 'clear disarms too');
  plan.freePlay();
  plan.arm(); // back to the menus
  assert.equal(plan.view, 'off');
  plan.drove();
  assert.equal(plan.view, 'off');
});

test('the browser store: a whole number under CARD_SEEN_KEY, 0 without storage or with junk', () => {
  const mem = new Map();
  globalThis.window = { localStorage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) } };
  try {
    assert.equal(C.localCardSeen.read(), 0);
    C.localCardSeen.write(2);
    assert.equal(mem.get(CARD_SEEN_KEY), '2');
    assert.equal(C.localCardSeen.read(), 2);
    mem.set(CARD_SEEN_KEY, 'junk');
    assert.equal(C.localCardSeen.read(), 0);
    mem.set(CARD_SEEN_KEY, '-4');
    assert.equal(C.localCardSeen.read(), 0);
    globalThis.window = {
      localStorage: {
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => {
          throw new Error('denied');
        },
      },
    };
    assert.equal(C.localCardSeen.read(), 0);
    C.localCardSeen.write(1); // swallowed
  } finally {
    delete globalThis.window;
  }
});
