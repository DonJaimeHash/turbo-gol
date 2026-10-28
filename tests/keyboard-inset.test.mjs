// The phone keyboard over the menus' forms (src/ui/keyboard.ts, plan PR 13): what it covers of the
// layout viewport and how far a field's scroller moves to keep the field above it.
// Run: node --test tests/keyboard-inset.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const K = await import('../src/ui/keyboard.ts');

test('the keyboard: what the visual viewport leaves of the layout one; a bar or rounding is none', () => {
  assert.equal(K.keyboardInset(844, 0, 844), 0);
  assert.equal(K.keyboardInset(844, 0, 520), 324);
  assert.equal(K.keyboardInset(844, 0, 800), 0, '44 px: a browser bar, not a keyboard');
  assert.equal(K.keyboardInset(844, 120, 400), 324, 'the visual viewport scrolled down');
});

test('a field under the keyboard comes up above it, never past the top of its scroller; one above the top comes down', () => {
  assert.equal(K.scrollToShow(300, 360, 16, 504), 0, 'in sight');
  assert.equal(K.scrollToShow(600, 660, 16, 504), 156);
  assert.equal(K.scrollToShow(100, 700, 16, 504), 84, 'taller than the room: its top stays in sight');
  assert.equal(K.scrollToShow(-40, 20, 16, 504), -56);
});
