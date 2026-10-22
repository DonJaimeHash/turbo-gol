// The loading screen's pure part (node --test tests/loading.test.mjs). LoadingOverlay.ts touches the
// DOM only inside its functions and class, so importing it in node also guards against module-level
// DOM access creeping in (main.ts imports it before anything else runs).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { nextProgress, LOADING_FADE_IN_MS, LOADING_FADE_OUT_MS } = await import('../src/ui/LoadingOverlay.ts');

test('the bar only moves forward and stays within 0..1', () => {
  assert.equal(nextProgress(0, 0.4), 0.4);
  assert.equal(nextProgress(0.4, 0.2), 0.4, 'never back');
  assert.equal(nextProgress(0.4, 0.4), 0.4);
  assert.equal(nextProgress(0.4, 1.7), 1);
  assert.equal(nextProgress(0, -0.3), 0);
  assert.equal(nextProgress(0.9, 1), 1);
});

test('a NaN or infinite request keeps the bar where it is (no NaN reaches the transform)', () => {
  for (const bad of [NaN, Infinity, -Infinity]) assert.equal(nextProgress(0.3, bad), 0.3, String(bad));
});

test('fade timings stay short: the overlay is a moment, not a wait', () => {
  assert.ok(LOADING_FADE_IN_MS > 0 && LOADING_FADE_IN_MS <= 250);
  assert.ok(LOADING_FADE_OUT_MS > LOADING_FADE_IN_MS && LOADING_FADE_OUT_MS <= 600);
});

test("style.css fades the overlay with the same timings LoadingOverlay waits for", async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  const rule = (sel) => {
    const i = css.indexOf(`${sel} {`);
    assert.ok(i >= 0, `${sel} is in style.css`);
    return css.slice(i, css.indexOf('}', i));
  };
  const secs = (ms) => `${ms / 1000}s`;
  assert.match(rule('.ld'), new RegExp(`opacity ${secs(LOADING_FADE_OUT_MS).replace('.', '\.')} `));
  assert.match(rule('.ld.ld-on'), new RegExp(`opacity ${secs(LOADING_FADE_IN_MS).replace('.', '\.')} `));
});

test('index.html carries the loading screen, open, so the first paint shows it', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<div id="overlay" class="ld ld-on"/);
  for (const cls of ['ld-logo', 'ld-bar', 'ld-fill', 'ld-line']) assert.ok(html.includes(cls), cls);
});
