// The UI's own icon sprite (src/ui/components/icons.ts): small, well formed, importable in node (no
// DOM at import: the menu screens that node tests load import it).
// Run: node --test tests/icons.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { ICON_PATHS, ICON_NAMES, spriteMarkup, iconId, SPRITE_ID } = await import('../src/ui/components/icons.ts');

test('about thirty icons, one sprite of at most 6 KB', () => {
  assert.ok(ICON_NAMES.length >= 30, String(ICON_NAMES.length));
  const bytes = Buffer.byteLength(spriteMarkup(), 'utf8');
  assert.ok(bytes <= 6 * 1024, `${bytes} B`);
});

test('every icon is one path on the 24 grid, with a symbol of its own', () => {
  const markup = spriteMarkup();
  assert.ok(markup.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" id="${SPRITE_ID}"`));
  for (const name of ICON_NAMES) {
    const d = ICON_PATHS[name];
    assert.match(d, /^M[-0-9MmLlHhVvCcSsQqAaZz .,]+$/, name);
    // Absolute coordinates stay on the grid (relative ones are deltas).
    for (const n of d.match(/-?\d*\.?\d+/g)) assert.ok(Math.abs(Number(n)) <= 24, `${name}: ${n}`);
    assert.equal(markup.split(`<symbol id="${iconId(name)}" viewBox="0 0 24 24">`).length, 2, name);
  }
  assert.equal(new Set(ICON_NAMES.map(iconId)).size, ICON_NAMES.length);
});

test('the sections, the devices and the common actions have an icon', () => {
  for (const n of ['play', 'training', 'garage', 'leaderboard', 'profile', 'settings', 'back', 'close', 'check', 'lock', 'server', 'pad', 'keyboard', 'touch', 'tv', 'lab', 'code', 'share', 'boost']) assert.ok(n in ICON_PATHS, n);
});
