// Hud pure helpers (node --test tests/hud-menu.test.mjs). Hud.ts touches the DOM only inside the
// class, so importing it in node also guards against module-level DOM access creeping in.
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

const { formatSettingValue, stepDecimals, stepSettingValue, MENU_CONTROL_ROWS, DIFFICULTIES, GAME_MODES, modeInfo, formatNetStats, choiceStep, experimentalTabLabel } = await import('../src/render/Hud.ts');
const { experimentalView, presetsLine } = await import('../src/render/experimentalPage.ts');
const { QUALITIES, menuQualities } = await import('../src/render/quality.ts');
const { newNetStatsView } = await import('../src/net/NetStats.ts');
const { CAMERA_RANGES, CONTROL_RANGES } = await import('../src/settings.ts');
const { MODES } = await import('../src/sim/constants.ts');

test('slider labels use the decimals implied by the step', () => {
  assert.equal(stepDecimals(1), 0);
  assert.equal(stepDecimals(10), 0);
  assert.equal(stepDecimals(0.5), 1);
  assert.equal(stepDecimals(0.05), 2);
  assert.equal(stepDecimals(0.01), 2);
  assert.equal(formatSettingValue(110, 1, '°'), '110°');
  assert.equal(formatSettingValue(-3, 1, '°'), '-3°');
  assert.equal(formatSettingValue(0.45, 0.05), '0.45');
  assert.equal(formatSettingValue(5, 0.5), '5.0');
  assert.equal(formatSettingValue(0.1, 0.01), '0.10');
});

test('stepping a slider snaps to the grid and clamps to the range', () => {
  assert.equal(stepSettingValue(1, 1, 1, 3, 0.05), 1.05);
  assert.equal(stepSettingValue(1.07, 1, 1, 3, 0.05), 1.1); // off-grid value snaps first
  assert.equal(stepSettingValue(3, 1, 1, 3, 0.05), 3);
  assert.equal(stepSettingValue(1, -1, 1, 3, 0.05), 1);
  assert.equal(stepSettingValue(0.1, -1, 0.05, 0.5, 0.01), 0.09);
  assert.equal(stepSettingValue(110, -1, 60, 110, 1), 109);
  assert.equal(stepSettingValue(-3, 1, -15, 0, 1), -2);
  assert.equal(stepSettingValue(270, 0, 100, 400, 10), 270); // dir 0 = normalise only
});

test('every slider range survives a full sweep without float drift', () => {
  const ranges = [...Object.values(CAMERA_RANGES), ...Object.values(CONTROL_RANGES).filter((r) => r !== null)];
  for (const [min, max, step] of ranges) {
    let v = min;
    const steps = Math.round((max - min) / step);
    for (let i = 0; i < steps; i++) v = stepSettingValue(v, 1, min, max, step);
    assert.equal(v, max, `sweep up ${min}..${max} by ${step}`);
    for (let i = 0; i < steps; i++) v = stepSettingValue(v, -1, min, max, step);
    assert.equal(v, min, `sweep down ${min}..${max} by ${step}`);
  }
});

test('main menu lists the driving rows plus ball cam, rear view and pause', () => {
  assert.deepEqual(
    MENU_CONTROL_ROWS.map((r) => r.action),
    ['throttle', 'reverse', 'steerLeft', 'steerRight', 'jump', 'boost', 'powerslide', 'ballCam', 'rearView', 'pause'],
  );
  assert.deepEqual(DIFFICULTIES, ['easy', 'medium', 'hard']);
});

test('the Mode row cycles through every sim mode and its info line counts the cars', () => {
  assert.deepEqual(GAME_MODES, ['1v1', '2v2', '3v3']);
  assert.deepEqual([...GAME_MODES].sort(), Object.keys(MODES).sort(), 'menu modes = constants.ts MODES');
  for (const mode of GAME_MODES) assert.equal(modeInfo(mode), `${mode} · ${MODES[mode] * 2} cars`);
  assert.equal(modeInfo('3v3'), '3v3 · 6 cars');
});

test('network panel: a host line only for a match on a community node', () => {
  const s = newNetStatsView();
  s.kind = 'server';
  s.state = 'playing';
  const lines = () => formatNetStats(s).split('\n');
  const plain = lines();
  assert.equal(plain[1].slice(0, 4), 'ping');
  s.host = 'GRU'; // a Durable Object's colo: the panel stays as it was
  assert.deepEqual(lines(), plain);
  s.host = 'node:sao-paulo-1';
  assert.deepEqual(lines(), [plain[0], 'host      node:sao-paulo-1', ...plain.slice(1)]);
  s.kind = 'p2p';
  assert.ok(!formatNetStats(s).includes('node:'), 'never on the P2P panel');
});

// ---- Settings > Graphics and Settings > Experimental (pure parts) -----------------------------------

test('Graphics list: a guest steps among Performance / High / Ultra; a device on Super low by itself lights nothing and steps to the nearest listed tier', () => {
  const locked = menuQualities(false);
  const unlocked = menuQualities(true);
  assert.equal(choiceStep(QUALITIES, unlocked, 'low', -1), 'superlow', 'unlocked: Super low is one step left of Performance');
  assert.equal(choiceStep(QUALITIES, locked, 'low', -1), null, 'locked: nothing left of Performance');
  assert.equal(choiceStep(QUALITIES, locked, 'low', 1), 'high');
  assert.equal(choiceStep(QUALITIES, locked, 'ultra', 1), null, 'no wrap on left / right');
  assert.equal(choiceStep(QUALITIES, locked, 'ultra', 0), 'low', 'accept wraps');
  // Super low running on its own (a TV), not listed: no chip lit, the first step goes up to Performance.
  assert.equal(locked.includes('superlow'), false);
  assert.equal(choiceStep(QUALITIES, locked, 'superlow', 1), 'low');
  assert.equal(choiceStep(QUALITIES, locked, 'superlow', 0), 'low');
  assert.equal(choiceStep(QUALITIES, locked, 'superlow', -1), null);
  assert.equal(choiceStep(QUALITIES, ['low', 'ultra'], 'high', -1), 'low', 'the nearest listed one that way');
  assert.equal(choiceStep(QUALITIES, ['low', 'ultra'], 'high', 1), 'ultra');
  assert.equal(choiceStep(QUALITIES, [], 'high', 1), null);
});

test('Experimental tab: a lock on the label for a guest', () => {
  assert.equal(experimentalTabLabel(true), 'Experimental');
  assert.equal(experimentalTabLabel(false), 'Experimental 🔒');
});

const STATE = { available: true, enabled: false, offRestarts: false, superlow: 'listed', presetNames: [], maxPresets: 10 };

test('Experimental page lines: the guest gets the locked line only; the switch shows its details when on', () => {
  assert.deepEqual(experimentalView(null, false), { locked: true, switchRow: false, confirm: false, details: false, superlowKey: 'settings.experimentalSuperlowListed' });
  assert.equal(experimentalView({ ...STATE, available: false }, false).locked, true);
  assert.deepEqual(experimentalView(STATE, false), { locked: false, switchRow: true, confirm: false, details: false, superlowKey: 'settings.experimentalSuperlowListed' });
  const on = { ...STATE, enabled: true };
  assert.equal(experimentalView(on, false).details, true);
  assert.equal(experimentalView({ ...on, superlow: 'chosen' }, false).superlowKey, 'settings.experimentalSuperlowChosen');
  assert.equal(experimentalView({ ...on, superlow: 'auto' }, false).superlowKey, 'settings.qualityAuto');
  assert.equal(experimentalView({ ...on, offRestarts: true }, true).confirm, true);
  assert.equal(experimentalView({ ...on, offRestarts: false }, true).confirm, false, 'nothing to confirm without a restart');
  assert.equal(presetsLine(on), 'No presets of your own yet (10 at most)');
  assert.equal(presetsLine({ ...on, presetNames: ['Moon', 'Fast #2'] }), 'Your presets (2/10): Moon, Fast #2');
});

/** The page with a fake row kit (no DOM): elements are plain objects, the toggle flips like the Hud's. */
function fakePage(build, options) {
  const line = (className, text) => {
    const e = { className, textContent: text ?? '', hidden: false, children: [], append: (...c) => e.children.push(...c) };
    return e;
  };
  return build(
    {
      line,
      toggleRow: (label, get, set) => {
        const row = line('row', label);
        const refresh = () => (row.on = get());
        const flip = () => {
          set(!get());
          refresh();
        };
        return { row, item: { el: row, left: flip, right: flip, accept: flip }, refresh };
      },
    },
    options,
  );
}

test('Experimental page: focus stops only on shown rows; turning it off with Super low picked takes a second press', async () => {
  const { buildExperimentalPage } = await import('../src/render/experimentalPage.ts');
  let state = { ...STATE, available: false };
  const sets = [];
  let opts = null;
  const page = fakePage(buildExperimentalPage, () => opts);
  assert.deepEqual(page.items(), [], 'no options: locked, the tab strip only');
  opts = { state: () => state, setEnabled: (on) => { sets.push(on); state = { ...state, enabled: on }; } };
  page.refresh();
  assert.deepEqual(page.items(), [], 'a guest: no switch to focus');
  const [locked, note, row, confirm, unlocks, superlow, presets] = page.page.children;
  assert.equal(locked.hidden, false);
  assert.equal(row.hidden, true);
  state = { ...STATE };
  page.refresh();
  assert.equal(page.items().length, 1);
  assert.equal(locked.hidden, true);
  assert.equal(note.hidden, false);
  assert.equal(unlocks.hidden, true, 'details only while on');
  page.items()[0].accept();
  assert.deepEqual(sets, [true]);
  page.refresh();
  assert.equal(unlocks.hidden, false);
  assert.equal(presets.textContent, 'No presets of your own yet (10 at most)');
  assert.equal(superlow.textContent, 'Super low is now listed in Graphics');
  // Super low is the player's pick: the first press only asks.
  state = { ...state, offRestarts: true, superlow: 'chosen' };
  page.refresh();
  assert.equal(superlow.textContent, 'Super low is your graphics quality');
  page.items()[0].accept();
  assert.deepEqual(sets, [true], 'not yet');
  assert.equal(confirm.hidden, false);
  assert.equal(confirm.textContent, 'Press again: Performance graphics, restarts');
  assert.equal(row.on, true, 'still on');
  page.disarm();
  assert.equal(confirm.hidden, true, 'leaving the tab forgets the first press');
  page.items()[0].accept();
  page.items()[0].accept();
  assert.deepEqual(sets, [true, false], 'the second press turns it off');
  assert.equal(confirm.hidden, true);
  // Super low only running on its own: off at once.
  state = { ...STATE, enabled: true, offRestarts: false, superlow: 'auto' };
  page.refresh();
  page.items()[0].accept();
  assert.deepEqual(sets, [true, false, false]);
});
