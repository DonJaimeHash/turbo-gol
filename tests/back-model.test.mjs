// The order of Back (src/ui/backModel.ts, plan §1.5), pure: in the menus (sheet, field, the
// screen's own, the stack, the section, JUGAR's root) and in the game (load, key capture, the Hud's
// screen, the menus, the pack summary, the match, the pause). Sections are no history entries of
// their own (backGuard.ts keeps one sentinel): Back from ENTRENAMIENTO comes to JUGAR, only JUGAR's
// root asks to leave. Also the sections' order and their stepping (shell/sections.ts).
//   node --test tests/back-model.test.mjs
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

const B = await import('../src/ui/backModel.ts');
const S = await import('../src/ui/shell/sections.ts');

const menu = (o = {}) => ({ sheet: 'none', editing: false, touch: false, screenBack: false, depth: 1, section: 'play', ...o });

test('menus: a sheet closes first, whatever is under it; a blocking one swallows Back', () => {
  assert.equal(B.menuBack(menu({ sheet: 'dismissable', editing: true, screenBack: true, depth: 3, section: 'training' })), 'closeSheet');
  assert.equal(B.menuBack(menu({ sheet: 'blocking', depth: 2 })), 'blocked');
});

test('menus: a field being edited stops editing (not with a finger: the keyboard already went)', () => {
  assert.equal(B.menuBack(menu({ editing: true, depth: 2 })), 'stopEditing');
  assert.equal(B.menuBack(menu({ editing: true, touch: true, depth: 2 })), 'pop');
});

test("menus: the screen's own back, then the stack pops", () => {
  assert.equal(B.menuBack(menu({ screenBack: true, depth: 3 })), 'screen');
  assert.equal(B.menuBack(menu({ screenBack: false, depth: 3 })), 'pop');
  assert.equal(B.menuBack(menu({ screenBack: false, depth: 2, section: 'training' })), 'pop', 'a stacked screen pops before the section changes');
});

test('menus: a section root other than JUGAR goes to JUGAR; JUGAR asks to leave', () => {
  for (const s of ['training', 'garage', 'leaderboard', 'profile']) assert.equal(B.menuBack(menu({ section: s })), 'home', s);
  assert.equal(B.menuBack(menu({ section: 'play' })), 'leave');
  assert.equal(B.menuBack(menu({ section: 'play', screenBack: true })), 'screen', 'a root with its own back (a sub-view) first');
});

test('system Back: nothing during a load; a capture is cancelled; the Hud screen, then the menus', () => {
  const sys = (o = {}) => ({ loading: false, capturing: false, hudMenu: false, menus: false, summary: false, playing: false, ...o });
  assert.equal(B.systemBack(sys({ loading: true, capturing: true, menus: true })), 'none');
  assert.equal(B.systemBack(sys({ capturing: true, hudMenu: true })), 'cancelCapture');
  assert.equal(B.systemBack(sys({ hudMenu: true, menus: true })), 'hud', 'Settings over the menus go back first');
  assert.equal(B.systemBack(sys({ menus: true })), 'menus');
  assert.equal(B.systemBack(sys({ summary: true })), 'leaveSummary');
  assert.equal(B.systemBack(sys({ playing: true })), 'pause', 'a match being played pauses');
  assert.equal(B.systemBack(sys({ hudMenu: true })), 'hud', 'the pause menu takes it');
  assert.equal(B.systemBack(sys()), 'none', 'a paused match stays paused; after the whistle the menus come back by themselves');
});

test('a walk of Back from a stacked screen in another section ends on the leave question, never off the site', () => {
  // ENTRENAMIENTO with a screen stacked on it, then Back four times.
  let st = menu({ section: 'training', depth: 2 });
  const steps = [];
  for (let i = 0; i < 4; i++) {
    const step = B.menuBack(st);
    steps.push(step);
    if (step === 'pop') st = { ...st, depth: st.depth - 1 };
    else if (step === 'home') st = { ...st, section: 'play', depth: 1 };
    else if (step === 'leave') st = { ...st, sheet: 'dismissable' };
    else if (step === 'closeSheet') st = { ...st, sheet: 'none' };
  }
  assert.deepEqual(steps, ['pop', 'home', 'leave', 'closeSheet']);
});

test('opening a screen: a section root opens its section; a stacked screen goes on its root, back to the top when there', () => {
  const at = (section, ...stack) => ({ section, stack });
  assert.deepEqual(B.stackAfterOpen(at('play', 'home'), 'training'), at('training', 'training'), 'the home tile: a section switch');
  assert.deepEqual(B.stackAfterOpen(at('training', 'training'), 'leaderboard'), at('leaderboard', 'leaderboard'));
  assert.deepEqual(B.stackAfterOpen(at('play', 'home', 'play', 'casual'), 'home'), at('play', 'home'), "JUGAR's root from its own stack");
  assert.deepEqual(B.stackAfterOpen(at('play', 'home'), 'play'), at('play', 'home', 'play'));
  assert.deepEqual(B.stackAfterOpen(at('play', 'home', 'play'), 'casual'), at('play', 'home', 'play', 'casual'));
  assert.deepEqual(B.stackAfterOpen(at('play', 'home', 'play', 'custom', 'lobby'), 'custom'), at('play', 'home', 'play', 'custom'), 'back down to a screen in the stack');
  assert.deepEqual(B.stackAfterOpen(at('play', 'home', 'play', 'casual'), 'ranked', true), at('play', 'home', 'ranked'), 'reset: right on the root');
  assert.deepEqual(B.stackAfterOpen(at('leaderboard', 'leaderboard'), 'casual'), at('play', 'home', 'casual'), "another section's screen: on its own root");
});

test("Competitive's SIGN IN opens PERFIL as a detour: Back comes back to Competitive", () => {
  const ranked = { section: 'play', stack: ['home', 'play', 'ranked'] };
  const st = B.stackAfterOpen(ranked, 'profile');
  assert.deepEqual(st, { section: 'play', stack: ['home', 'play', 'ranked', 'profile'] }, 'stacked on Competitive, JUGAR still the section');
  assert.equal(B.menuBack(menu({ section: st.section, depth: st.stack.length })), 'pop', 'Back pops PERFIL');
  assert.deepEqual(st.stack.slice(0, -1), ranked.stack);
  // From a section root it is a plain switch (the home tile, the chip): Back goes to JUGAR.
  assert.deepEqual(B.stackAfterOpen({ section: 'play', stack: ['home'] }, 'profile'), { section: 'profile', stack: ['profile'] });
  assert.equal(B.menuBack(menu({ section: 'profile', depth: 1 })), 'home');
  // The search pill (reset) and a reload always land on a section's own stack.
  assert.deepEqual(B.stackAfterOpen(ranked, 'profile', true), { section: 'profile', stack: ['profile'] });
});

test('sections: five, JUGAR first, each with its root; the stacked screens belong to JUGAR', () => {
  assert.deepEqual(
    S.SECTIONS.map((s) => s.id),
    ['play', 'training', 'garage', 'leaderboard', 'profile'],
  );
  assert.equal(S.HOME_SECTION, 'play');
  assert.deepEqual(
    S.SECTIONS.map((s) => s.root),
    ['home', 'training', 'garage', 'leaderboard', 'profile'],
  );
  for (const id of ['home', 'training', 'garage', 'leaderboard', 'profile']) assert.notEqual(S.rootSection(id), null, id);
  for (const id of ['play', 'casual', 'ranked', 'friendly', 'custom', 'lobby-create', 'lobby']) {
    assert.equal(S.rootSection(id), null, id);
    assert.equal(S.sectionOf(id), 'play', id);
  }
  assert.equal(S.sectionOf('leaderboard'), 'leaderboard');
});

test('sections: LB / RB and Q / E step one, no wrap', () => {
  assert.equal(S.stepSection('play', 1), 'training');
  assert.equal(S.stepSection('training', -1), 'play');
  assert.equal(S.stepSection('profile', -1), 'leaderboard');
  assert.equal(S.stepSection('play', -1), null);
  assert.equal(S.stepSection('profile', 1), null);
});
