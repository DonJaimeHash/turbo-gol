// The pause keys (src/game/pauseKeys.ts, node --test tests/pause-keys.test.mjs): Esc / Start toggle
// the pause, a bare back edge (pad B, Backspace) resumes it, and nothing a key does ever quits the
// match (only the pause menu's QUIT button, with its second press online); the key line under PAUSED
// names the keys that resume, in English and Spanish, and no quit key.
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

const { pauseKeyAction, pauseResumeKeys } = await import('../src/game/pauseKeys.ts');
const { t } = await import('../src/i18n.ts');
const es = (await import('../src/locales/es.ts')).default;

// Input's edges per key: Esc / Start carry `pause` and `back`; pad B and Backspace only `back`.
const ESC = [true, true];
const B = [false, true];
const NONE = [false, false];

test('playing: Esc / Start pause; B (boost) and Backspace (reset ball) do nothing to the pause', () => {
  assert.equal(pauseKeyAction(...ESC, false, false), 'toggle');
  assert.equal(pauseKeyAction(...B, false, false), null);
  assert.equal(pauseKeyAction(...NONE, false, false), null);
});

test('paused: Esc / Start, pad B and Backspace all resume; no key quits', () => {
  assert.equal(pauseKeyAction(...ESC, true, false), 'toggle');
  assert.equal(pauseKeyAction(...B, true, false), 'resume');
  assert.equal(pauseKeyAction(...NONE, true, false), 'menu', 'the menu edges (focus, accept)');
  // The Escape of a pointer-lock release that already paused: neither resumes nor toggles.
  assert.equal(pauseKeyAction(...ESC, true, true), 'menu');
  for (const pause of [false, true]) {
    for (const back of [false, true]) {
      for (const paused of [false, true]) {
        for (const drop of [false, true]) {
          const r = pauseKeyAction(pause, back, paused, drop);
          assert.ok(r === 'toggle' || r === 'resume' || r === 'menu' || r === null, String(r));
          if (paused && back) assert.notEqual(r, null, 'a back key while paused is never ignored into a quit path');
        }
      }
    }
  }
});

test('the key line: the pause bindings and the back keys that resume, each once, no quit key', () => {
  assert.equal(pauseResumeKeys('Esc', 'Start'), 'Esc / Start / B');
  assert.equal(pauseResumeKeys('P', 'Start'), 'P / Esc / Start / B', 'Esc resumes whatever the pause binding');
  assert.equal(pauseResumeKeys('Esc', 'B'), 'Esc / B');
  assert.equal(pauseResumeKeys('—', 'Start'), 'Esc / Start / B');
  const en = t('pause.hint', { resumeKeys: pauseResumeKeys('Esc', 'Start') });
  assert.equal(en, 'Esc / Start / B or click to resume');
  assert.equal(t('pause.hintDefault', { resumeKeys: pauseResumeKeys('Esc', 'Start') }), 'Esc / Start / B to resume');
  for (const line of [en, es['pause.hint'], es['pause.hintDefault'], t('pause.hintDefault', { resumeKeys: 'x' })]) {
    assert.ok(!/quit|salir|Backspace|\{quitKeys\}/i.test(line), line);
  }
});
