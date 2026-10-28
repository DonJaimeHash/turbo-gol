// Ajustes, pure (src/ui/screens/settings/model.ts): the rail's tabs, CONTROLES' device sections, the
// camera preset, the quality trial, the memory tag, a binding's conflict, the slider maths, and
// where Ajustes stacks (backModel.ts: a screen of every section).
//   node --test tests/settings-model.test.mjs
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

const M = await import('../src/ui/screens/settings/model.ts');
const { stackAfterOpen } = await import('../src/ui/backModel.ts');
const { DEFAULT_KBM } = await import('../src/input/bindings.ts');
const { DEFAULT_CAMERA, CLASSIC_CAMERA_DEFAULTS, CAMERA_RANGES } = await import('../src/settings.ts');

test('the rail: six tabs in the artboard order, L / R step round, Menu.open tabs by name', () => {
  assert.deepEqual(M.SETTINGS_TABS.map((x) => x.id), ['controls', 'camera', 'game', 'audio', 'graphics', 'experimental']);
  assert.equal(M.stepSettingsTab('controls', -1), 'experimental');
  assert.equal(M.stepSettingsTab('experimental', 1), 'controls');
  assert.equal(M.stepSettingsTab('camera', 1), 'game');
  assert.equal(M.asSettingsTab('experimental'), 'experimental');
  assert.equal(M.asSettingsTab('kbm'), null, "today's old tab names are none");
  assert.equal(M.asSettingsTab(undefined), null);
});

test('CONTROLES: only the devices detected, in order; none detected shows CONTROL; it opens on the last input', () => {
  assert.deepEqual(M.controlSections({ touch: true, pad: true, kbm: true }), ['touch', 'pad', 'kbm']);
  assert.deepEqual(M.controlSections({ touch: false, pad: false, kbm: true }), ['kbm']);
  assert.deepEqual(M.controlSections({ touch: true, pad: false, kbm: false }), ['touch']);
  assert.deepEqual(M.controlSections({ touch: false, pad: false, kbm: false }), ['pad'], 'a TV with only its remote: CONTROL says none is connected');
  const all = ['touch', 'pad', 'kbm'];
  assert.equal(M.openingSection('touch', all), 'touch');
  assert.equal(M.openingSection('pad', all), 'pad');
  assert.equal(M.openingSection('remote', all), 'pad');
  assert.equal(M.openingSection('keyboard', all), 'kbm');
  assert.equal(M.openingSection('mouse', all), 'kbm');
  assert.equal(M.openingSection('pad', ['kbm']), 'kbm', 'not shown: the first shown');
  assert.equal(M.keptSection('kbm', all, 'pad'), 'kbm', 'a pick stays while shown');
  assert.equal(M.keptSection('pad', ['kbm'], 'pad'), 'kbm', 'the controller went: the last input decides again');
});

test('a binding on a key another action has is said (shared keys stay legal: nothing is swapped)', () => {
  assert.equal(M.bindConflict(DEFAULT_KBM, 'boost', DEFAULT_KBM.throttle), 'throttle');
  assert.equal(M.bindConflict(DEFAULT_KBM, 'ballCam', DEFAULT_KBM.throttle), 'throttle', 'a camera key on a driving one');
  assert.equal(M.bindConflict(DEFAULT_KBM, 'throttle', DEFAULT_KBM.throttle), null, 'W throttles and pitches: the standard layout shares it (driving and air)');
  assert.equal(M.bindConflict(DEFAULT_KBM, 'airRoll', DEFAULT_KBM.powerslide), null, 'Shift drifts and air-rolls');
  assert.equal(M.bindConflict(DEFAULT_KBM, 'boost', { kind: 'key', code: 'F9' }), null);
  assert.equal(M.bindConflict(DEFAULT_KBM, 'boost', null), null);
});

test('CÁMARA: the preset the live values match, null once a slider moved', () => {
  assert.equal(M.cameraPresetOf(DEFAULT_CAMERA, DEFAULT_CAMERA, CLASSIC_CAMERA_DEFAULTS), 'default');
  assert.equal(M.cameraPresetOf({ ...CLASSIC_CAMERA_DEFAULTS }, DEFAULT_CAMERA, CLASSIC_CAMERA_DEFAULTS), 'classic');
  assert.equal(M.cameraPresetOf({ ...DEFAULT_CAMERA, fov: 100 }, DEFAULT_CAMERA, CLASSIC_CAMERA_DEFAULTS), null);
});

test('GRÁFICOS: a trial counts 10 s down from the switch; the memory tag is for High / Ultra on 4 GB or less', () => {
  const tr = M.startTrial('high', 'ultra', 1000);
  assert.deepEqual(tr, { from: 'high', to: 'ultra', until: 11_000 });
  assert.equal(M.trialSecondsLeft(tr, 1000), 10);
  assert.equal(M.trialSecondsLeft(tr, 1001), 10);
  assert.equal(M.trialSecondsLeft(tr, 10_001), 1);
  assert.equal(M.trialSecondsLeft(tr, 11_000), 0);
  assert.equal(M.trialSecondsLeft(tr, 20_000), 0);
  assert.equal(M.memoryTag('ultra', 4), true);
  assert.equal(M.memoryTag('high', 2), true);
  assert.equal(M.memoryTag('low', 1), false);
  assert.equal(M.memoryTag('ultra', 8), false);
  assert.equal(M.memoryTag('ultra', undefined), false, 'unknown (Firefox, Safari, http): no tag');
});

test('sliders: the thumb and the default mark on the track, a pointer snapped to the grid', () => {
  assert.equal(M.sliderPercent(110, 60, 110), 100);
  assert.equal(M.sliderPercent(85, 60, 110), 50);
  assert.equal(M.sliderPercent(0, 60, 110), 0, 'clamped');
  const [min, max, step] = CAMERA_RANGES.fov;
  assert.equal(M.valueAt(100, 100, 200, min, max, step), 60);
  assert.equal(M.valueAt(300, 100, 200, min, max, step), 110);
  assert.equal(M.valueAt(200, 100, 200, min, max, step), 85);
  assert.equal(M.valueAt(51, 0, 100, 0, 1, 0.05), 0.5, 'onto the step');
  assert.equal(M.valueAt(10, 0, 0, 0, 1, 0.05), 0, 'a track not laid out');
});

test('Ajustes stacks on the screen shown, whatever its section (Back returns there); reset: on its root', () => {
  assert.deepEqual(stackAfterOpen({ section: 'training', stack: ['training'] }, 'settings'), { section: 'training', stack: ['training', 'settings'] });
  assert.deepEqual(stackAfterOpen({ section: 'play', stack: ['home', 'modes'] }, 'settings'), { section: 'play', stack: ['home', 'modes', 'settings'] });
  assert.deepEqual(stackAfterOpen({ section: 'leaderboard', stack: ['leaderboard'] }, 'settings', true), { section: 'leaderboard', stack: ['leaderboard', 'settings'] });
  // A guest's SIGN IN from it: PERFIL as a detour on top, Back comes back.
  assert.deepEqual(stackAfterOpen({ section: 'play', stack: ['home', 'settings'] }, 'profile'), { section: 'play', stack: ['home', 'settings', 'profile'] });
});

test("a guest's SIGN IN comes back to EXPERIMENTAL: from a detour on PERFIL, and from Ajustes over PERFIL's root", async () => {
  const { settingsScreen } = await import('../src/ui/screens/settings/screen.ts');
  const tick = () => new Promise((r) => setTimeout(r, 0));
  // Menu's stack (open, back, openSettings, mount's hide of an unstacked Ajustes) around the screen.
  const make = (section, stack) => {
    const subs = [];
    const accounts = { signedIn: false, subscribe: (f) => subs.push(f) };
    const view = { isOpen: false, tab: null, waitingSignIn: false, open(tab) { this.isOpen = true; this.tab = tab ?? 'controls'; }, close() { this.isOpen = false; this.waitingSignIn = false; }, resume() {}, suspend() {} };
    const screens = new Map();
    const menu = {
      host: { accounts },
      section,
      stack,
      visible: true,
      top: () => screens.get(menu.stack.at(-1)) ?? { id: menu.stack.at(-1) },
      stacked: (id) => menu.stack.includes(id),
      mount() {
        menu.top().show?.();
        if (!menu.stacked('settings')) screens.get('settings').hide();
      },
      open(id) {
        const next = stackAfterOpen({ section: menu.section, stack: menu.stack }, id);
        menu.top().hide?.();
        ({ section: menu.section, stack: menu.stack } = next);
        menu.mount();
      },
      back() {
        menu.top().hide?.();
        menu.stack = menu.stack.slice(0, -1);
        menu.mount();
      },
      openSettings(_onClose, opts) {
        view.open(opts?.tab ?? null);
        menu.open('settings');
      },
    };
    screens.set('settings', settingsScreen(menu, view));
    const signIn = async () => {
      view.waitingSignIn = true;
      menu.open('profile');
      await tick();
    };
    const signedIn = async () => {
      accounts.signedIn = true;
      for (const f of subs) f();
      await tick();
    };
    return { menu, view, signIn, signedIn };
  };
  const detour = make('play', ['home']);
  detour.menu.openSettings(undefined, { tab: 'experimental' });
  await detour.signIn();
  assert.deepEqual(detour.menu.stack, ['home', 'settings', 'profile'], 'PERFIL a detour over Ajustes');
  assert.equal(detour.view.isOpen, true);
  await detour.signedIn();
  assert.deepEqual(detour.menu.stack, ['home', 'settings']);
  assert.equal(detour.view.tab, 'experimental');

  const own = make('profile', ['profile']);
  own.menu.openSettings();
  own.view.tab = 'experimental';
  await own.signIn();
  assert.deepEqual(own.menu.stack, ['profile'], "PERFIL's root: Ajustes left the stack");
  assert.equal(own.view.isOpen, false);
  await own.signedIn();
  assert.deepEqual(own.menu.stack, ['profile', 'settings'], 'Ajustes again, over PERFIL');
  assert.equal(own.view.isOpen, true);
  assert.equal(own.view.tab, 'experimental');

  const left = make('profile', ['profile']);
  left.menu.openSettings();
  await left.signIn();
  left.menu.open('home');
  await tick();
  left.menu.open('profile');
  await tick();
  await left.signedIn();
  assert.deepEqual(left.menu.stack, ['profile'], 'PERFIL left before the sign-in: no Ajustes');
  assert.equal(left.view.isOpen, false);
});
