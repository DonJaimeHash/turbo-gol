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

const { formatSettingValue, stepDecimals, stepSettingValue, DIFFICULTIES, GAME_MODES, formatNetStats, choiceStep, experimentalTabLabel, netBars, avoidRects } = await import('../src/render/Hud.ts');
const { experimentalView, stepPreset, stepRuleValue } = await import('../src/render/experimentalPage.ts');
const RT = await import('../src/render/rulesText.ts');
const R = await import('../src/game/physicsRules.ts');
const { QUALITIES, CARD_QUALITIES } = await import('../src/render/quality.ts');
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

test('the difficulties and the modes the menus offer: every sim mode, in order (the old Hud menu and modeInfo are gone, plan PR 7)', () => {
  assert.deepEqual(DIFFICULTIES, ['easy', 'medium', 'hard']);
  assert.deepEqual(GAME_MODES, ['1v1', '2v2', '3v3']);
  assert.deepEqual([...GAME_MODES].sort(), Object.keys(MODES).sort(), 'menu modes = constants.ts MODES');
});

test('the network bars by the clock: 3 good, 2 fair, 1 poor by round trip or loss; none before a measure', () => {
  assert.equal(netBars(0, 0), 0);
  assert.equal(netBars(-1, 0), 0);
  assert.equal(netBars(40, 0), 3);
  assert.equal(netBars(120, 0), 2);
  assert.equal(netBars(40, 4), 2);
  assert.equal(netBars(250, 0), 1);
  assert.equal(netBars(60, 10), 1);
});

test('the ball indicator steps out of a HUD plate the shortest way that stays on screen', () => {
  const out = { x: 0, y: 0 };
  const score = { left: 30, top: 26, right: 282, bottom: 72 };
  // Pinned to the top edge over the scorebug: below it (to its right would be farther).
  avoidRects(100, 20, 20, [score], 1366, 768, out);
  assert.deepEqual(out, { x: 100, y: 92 });
  avoidRects(270, 20, 20, [score], 1366, 768, out);
  assert.deepEqual(out, { x: 302, y: 20 });
  // Clear of every plate: where it was.
  avoidRects(700, 20, 20, [score], 1366, 768, out);
  assert.deepEqual(out, { x: 700, y: 20 });
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

test('Graphics cards: Performance / High / Ultra (Super low is the switch under them); a device on Super low lights nothing and steps to the nearest card', () => {
  const locked = CARD_QUALITIES;
  assert.equal(choiceStep(QUALITIES, locked, 'low', -1), null, 'nothing left of Performance');
  assert.equal(choiceStep(QUALITIES, locked, 'low', 1), 'high');
  assert.equal(choiceStep(QUALITIES, locked, 'ultra', 1), null, 'no wrap on left / right');
  assert.equal(choiceStep(QUALITIES, locked, 'ultra', 0), 'low', 'accept wraps');
  // Super low running (its switch on, or a TV on its own), not a card: none lit, the first step goes up to Performance.
  assert.equal(locked.includes('superlow'), false);
  assert.equal(choiceStep(QUALITIES, locked, 'superlow', 1), 'low');
  assert.equal(choiceStep(QUALITIES, locked, 'superlow', 0), 'low');
  assert.equal(choiceStep(QUALITIES, locked, 'superlow', -1), null);
  assert.equal(choiceStep(QUALITIES, ['low', 'ultra'], 'high', -1), 'low', 'the nearest listed one that way');
  assert.equal(choiceStep(QUALITIES, ['low', 'ultra'], 'high', 1), 'ultra');
  assert.equal(choiceStep(QUALITIES, [], 'high', 1), null);
});

test('Experimental tab: the same label for a guest, no emoji (the rail draws the lock)', () => {
  assert.equal(experimentalTabLabel(true), 'Experimental');
  assert.equal(experimentalTabLabel(false), 'Experimental');
});

const STATE = { available: true, enabled: false };

test('Experimental page lines: the guest gets the locked line only; the switch shows its details when on; the editor needs the presets and the switch', () => {
  const none = { locked: true, switchRow: false, details: false, editor: false, match: false };
  assert.deepEqual(experimentalView(null), none);
  assert.deepEqual(experimentalView({ ...STATE, available: false }, true, 'match'), none, 'a guest: nothing, whatever the context');
  assert.deepEqual(experimentalView(STATE), { locked: false, switchRow: true, details: false, editor: false, match: false });
  const on = { ...STATE, enabled: true };
  assert.equal(experimentalView(on).details, true);
  assert.equal(experimentalView(on).editor, false, 'no presets: no editor');
  assert.equal(experimentalView(on, true).editor, true);
  assert.equal(experimentalView(on, true, 'training').editor, true);
  assert.equal(experimentalView(STATE, true).editor, false, 'the switch off hides the editor');
  assert.deepEqual([experimentalView(on, true, 'match').editor, experimentalView(on, true, 'match').match], [false, true], 'a match: its rules, read-only');
  assert.equal(experimentalView(STATE, true, 'match').match, true, "the room decided: a member's switch is not checked");
});

test('preset picker and value steps: wrap through the presets; ranges stop at their ends, accept wraps a choice', () => {
  const list = [{ id: 'standard' }, { id: 'lowGravity' }, { id: 'aaaaaaaaaaaa' }];
  assert.equal(stepPreset(list, 'standard', 1), 'lowGravity');
  assert.equal(stepPreset(list, 'standard', -1), 'aaaaaaaaaaaa', 'wraps back');
  assert.equal(stepPreset(list, 'aaaaaaaaaaaa', 1), 'standard', 'wraps on');
  assert.equal(stepPreset(list, 'gone', 1), 'lowGravity', 'an id not listed counts as the first');
  assert.equal(stepPreset([], 'standard', 1), null);
  const gravity = R.physicsField('gravity');
  assert.equal(stepRuleValue(gravity, 100, 1), 110);
  assert.equal(stepRuleValue(gravity, 30, -1), 30, 'stops at the minimum');
  assert.equal(stepRuleValue(gravity, 200, 1), 200, 'stops at the maximum');
  assert.equal(stepRuleValue(gravity, 47, 1), 60, 'an off-grid value snaps first');
  const demo = R.physicsField('demoMode');
  assert.deepEqual([stepRuleValue(demo, 0, 0), stepRuleValue(demo, 1, 0), stepRuleValue(demo, 2, 0)], [1, 2, 0], 'accept wraps');
  assert.equal(stepRuleValue(demo, 2, 1), 2);
  assert.deepEqual([stepRuleValue(R.physicsField('unlimitedFlips'), 0, 0), stepRuleValue(R.physicsField('unlimitedFlips'), 1, 0)], [1, 0]);
  assert.equal(stepRuleValue(R.physicsField('spawnBoost'), 33, -1), 0);
});

test('rule texts: speeds in km/h, % of standard, seconds, on / off, the demolitions option, endless boost; the summary line', () => {
  const f = (k) => R.physicsField(k);
  assert.equal(RT.formatRuleValue(f('gravity'), 50), '50%');
  assert.equal(RT.formatRuleValue(f('ballMaxSpeed'), 100), '216 km/h');
  assert.equal(RT.formatRuleValue(f('ballMaxSpeed'), 130), '281 km/h');
  assert.equal(RT.formatRuleValue(f('carMaxSpeed'), 2300), '83 km/h', 'the HUD shows 83 at 2300 uu/s');
  assert.equal(RT.formatRuleValue(f('carMaxSpeed'), 2600), '94 km/h');
  assert.equal(RT.formatRuleValue(f('respawnDelay'), 3), '3 s');
  assert.equal(RT.formatRuleValue(f('spawnBoost'), 33), '33');
  assert.equal(RT.formatRuleValue(f('unlimitedFlips'), 1), 'ON');
  assert.equal(RT.formatRuleValue(f('demoMode'), 1), 'On contact');
  assert.equal(RT.formatRuleValue(f('boostUse'), 0), 'Endless');
  assert.equal(RT.formatRuleValue(f('boostUse'), 50), '50%');
  assert.equal(RT.standardText(f('ballMaxSpeed')), 'Standard 216 km/h');
  assert.equal(RT.rulesSummary({}), 'Standard physics');
  assert.equal(RT.rulesSummary({ ballDrag: 50, gravity: 50 }), 'Gravity 50% · Air drag (ball) 50%', 'table order');
  assert.equal(RT.rulesSummary({ gravity: 50, ballHit: 150, ballWeight: 80, bumpForce: 0 }, 2), 'Gravity 50% · Hit strength 150% · +2 more');
  assert.equal(RT.rulesSummary({ gameSpeed: 50 }, 4, 'match'), 'Standard physics', 'a match leaves the free-play keys out');
  assert.equal(RT.presetName({ id: 'lowGravity', builtIn: true, name: '' }), 'Low gravity');
  assert.equal(RT.presetName({ id: '0123456789ab', builtIn: false, name: 'Moon' }), 'Moon');
});

/** A fake element: what the page touches (class list, text, hidden, children; buttons click, inputs commit). */
function fakeEl(className, text) {
  const cls = new Set(className.split(/\s+/).filter(Boolean));
  const e = {
    className,
    textContent: text ?? '',
    hidden: false,
    disabled: false,
    children: [],
    append: (...c) => e.children.push(...c),
    classList: {
      toggle: (c, on) => {
        const v = on === undefined ? !cls.has(c) : on;
        if (v) cls.add(c);
        else cls.delete(c);
        return v;
      },
      add: (c) => cls.add(c),
      remove: (c) => cls.delete(c),
      contains: (c) => cls.has(c),
    },
  };
  return e;
}

/** The page with a fake row kit (no DOM): elements are plain objects, the toggle flips like the Hud's. */
function fakePage(build, options) {
  const kit = {
    relayouts: 0,
    line: (className, text) => fakeEl(className, text),
    button: (className, text, onClick) => {
      const b = fakeEl(className, text);
      b.click = () => {
        if (!b.disabled) onClick();
      };
      return b;
    },
    textInput: (className, maxLength, onCommit) => {
      const i = fakeEl(className);
      i.value = '';
      i.maxLength = maxLength;
      i.focused = false;
      i.focus = () => (i.focused = true);
      i.select = () => undefined;
      i.matches = (q) => q === ':focus' && i.focused;
      /** Typed, then left (Enter / Esc / a tap elsewhere). */
      i.type = (v) => {
        i.value = v;
        i.focused = false;
        onCommit(v);
      };
      return i;
    },
    toggleRow: (label, get, set) => {
      const row = fakeEl('row', label);
      const refresh = () => (row.on = get());
      const flip = () => {
        set(!get());
        refresh();
      };
      return { row, item: { el: row, left: flip, right: flip, accept: flip }, refresh };
    },
    bindFocus: () => undefined,
    relayout: () => kit.relayouts++,
  };
  const page = build(kit, options);
  page.kit = kit;
  return page;
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
  const [locked, note, row, unlocks, matchLine, editor] = page.page.children;
  assert.equal(locked.hidden, false);
  assert.equal(row.hidden, true);
  assert.equal(editor.hidden, true);
  // The Hud shows the tab's footer with the tab: a guest still gets no Reset button there.
  page.actions.hidden = false;
  page.refresh();
  assert.equal(page.actions.children[0].hidden, true, 'a guest: no Reset to standard');
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
  assert.equal(unlocks.textContent, 'Unlocks Experimental free play and lobby rules', 'Super low is not among them (Graphics, everyone)');
  assert.equal(matchLine.hidden, true);
  assert.equal(editor.hidden, true, 'no presets in the options: no editor');
  // Off at once: nothing restarts.
  page.items()[0].accept();
  assert.deepEqual(sets, [true, false]);
  assert.equal(row.on, false);
});

/** The editor over a real ExperimentalStore (memory storage, a fake account that accepts everything). */
async function editorPage(context = 'menu') {
  const { buildExperimentalPage } = await import('../src/render/experimentalPage.ts');
  const { ExperimentalStore } = await import('../src/game/experimentalStore.ts');
  const m = new Map();
  const storage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  const server = { presets: [], online: true };
  const answer = () => ({ enabled: true, presets: server.presets.map((p) => ({ ...p })) });
  const remote = {
    accountId: () => 'abcdef0123456789',
    fetch: async () => answer(),
    setEnabled: async () => answer(),
    upsert: async (p) => {
      server.presets = [...server.presets.filter((q) => q.id !== p.id), { ...p, updatedAt: 1 }];
      return answer();
    },
    remove: async (id) => {
      if (!server.online) throw Object.assign(new Error('offline'), { code: 'network' });
      server.presets = server.presets.filter((q) => q.id !== id);
      return answer();
    },
  };
  let n = 0;
  const store = new ExperimentalStore(remote, { storage, setTimer: () => 0, clearTimer: () => undefined, newId: () => (++n).toString(16).padStart(12, '0') });
  store.setEnabled(true);
  const state = { ...STATE, enabled: true };
  const opts = { state: () => state, setEnabled: () => undefined, presets: store, context, matchRules: 'Low gravity · Gravity 50%' };
  const page = fakePage(buildExperimentalPage, () => opts);
  page.refresh();
  const editor = page.page.children[5];
  const find = (cls) => {
    const out = [];
    const walk = (e) => {
      if (e.classList?.contains(cls)) out.push(e);
      for (const c of e.children ?? []) walk(c);
    };
    walk(page.page);
    walk(page.actions);
    return out;
  };
  const labelOf = (item) => item.el.children[0]?.children?.[0]?.textContent ?? item.el.children[0]?.textContent;
  const rowItem = (label) => page.items().find((it) => it.el.classList.contains('hud-rule-row') && labelOf(it) === label);
  const buttons = () => find('hud-exp-buttons')[0].children;
  const press = (text) => buttons().find((b) => b.textContent === text || b.textContent.startsWith(text)).click();
  return { page, store, server, opts, editor, find, rowItem, buttons, press, text: (cls) => find(cls)[0].textContent };
}

test('Preset editor: built-ins are read-only (duplicate them); New and Duplicate name their copies; every value steps on its grid; Delete and Reset take a second press', async () => {
  const E = await editorPage();
  const { page, store, find, rowItem, buttons, press, text } = E;
  assert.equal(E.editor.hidden, false);
  // Standard (a built-in) on screen: the picker, the buttons and the 17 inert rows; no name, no reset.
  assert.equal(text('hud-exp-picker-value'), 'Standard');
  assert.equal(text('hud-exp-picker-hint'), 'Built-in: duplicate it to edit');
  assert.equal(text('hud-exp-summary'), 'Changes: Standard physics');
  assert.equal(page.items().length, 1 + 2 + R.PHYSICS_FIELDS.length, 'switch, picker, buttons, one stop per value');
  assert.deepEqual(buttons().map((b) => [b.textContent, b.disabled]), [['New', false], ['Duplicate', false], ['Rename', true], ['Delete', true]]);
  assert.equal(find('hud-exp-name-row')[0].hidden, true);
  assert.equal(page.actions.children[0].hidden, true, 'no Reset for a built-in');
  page.actions.hidden = false; // the Hud shows the tab's actions with the tab (selectTab)
  page.refresh();
  assert.equal(page.actions.children[0].hidden, true, 'still none once the Hud shows the actions');
  const gravityRow = rowItem('Gravity');
  gravityRow.right();
  assert.equal(store.get('standard').values.gravity, undefined, 'a built-in never changes');
  assert.ok(gravityRow.el.classList.contains('hud-rule-locked'));
  // The picker wraps through the built-ins.
  const picker = page.items()[1];
  picker.right();
  assert.equal(text('hud-exp-picker-value'), 'Low gravity');
  assert.equal(store.lastUsed(), 'lowGravity', 'the pick is remembered (lastUsed)');
  assert.equal(text('hud-exp-summary'), 'Changes: Gravity 50% · Air drag (ball) 50%');
  picker.left();
  picker.left();
  assert.equal(text('hud-exp-picker-value'), 'Arcade', 'left from the first wraps to the last');
  picker.right();
  picker.right();
  // Duplicate the built-in: "Low gravity #2", the player's own, editable.
  press('Duplicate');
  assert.equal(text('hud-exp-picker-value'), 'Low gravity #2');
  const copy = store.get(store.lastUsed());
  assert.equal(copy.builtIn, false);
  assert.deepEqual(copy.values, { gravity: 50, ballDrag: 50 });
  assert.equal(text('hud-exp-picker-hint'), 'Your presets: 1 of 10');
  assert.equal(find('hud-exp-name')[0].value, 'Low gravity #2');
  assert.equal(page.actions.children[0].hidden, false);
  assert.equal(page.items().length, 1 + 2 + 1 + R.PHYSICS_FIELDS.length + 1, '+ the name and Reset');
  assert.ok(page.kit.relayouts > 0, 'the Hud re-reads the focus stops after an action');
  // Ranges step and stop at their ends; Delete (clear) puts the standard value back.
  const g = rowItem('Gravity');
  g.right();
  assert.equal(store.get(copy.id).values.gravity, 60);
  for (let i = 0; i < 5; i++) g.left();
  assert.equal(store.get(copy.id).values.gravity, 30, 'stops at 30%');
  assert.equal(g.el.children[1].children[1].textContent, '30%');
  assert.ok(g.el.classList.contains('hud-rule-changed'));
  assert.equal(g.el.children[1].children[0].disabled, true, '− is off at the minimum');
  g.clear();
  assert.equal(store.get(copy.id).values.gravity, undefined, 'back to standard');
  assert.equal(g.el.classList.contains('hud-rule-changed'), false);
  // A choice wraps on accept; a toggle flips; the km/h row shows the standard under the name.
  const demo = rowItem('Demolitions');
  demo.accept();
  demo.accept();
  assert.equal(store.get(copy.id).values.demoMode, 2);
  assert.equal(demo.el.children[1].children[1].textContent, 'Off');
  rowItem('Unlimited flips').accept();
  assert.equal(store.get(copy.id).values.unlimitedFlips, 1);
  const speed = rowItem('Ball top speed');
  assert.equal(speed.el.children[0].children[1].textContent, 'Standard 216 km/h');
  assert.match(rowItem('Game speed').el.children[0].children[1].textContent, /Free play only/);
  assert.equal(text('hud-exp-summary'), 'Changes: Air drag (ball) 50% · Unlimited flips ON · Demolitions Off');
  // New: "My rules 1", standard values.
  press('New');
  assert.equal(text('hud-exp-picker-value'), 'My rules 1');
  assert.deepEqual(store.get(store.lastUsed()).values, {});
  // Rename through the name field; a name the lobby rules refuse is not taken and says why.
  const name = find('hud-exp-name')[0];
  name.type('Moon base');
  assert.equal(text('hud-exp-picker-value'), 'Moon base');
  name.type('x');
  assert.equal(text('hud-exp-picker-value'), 'Moon base');
  assert.equal(find('hud-exp-status')[0].hidden, false);
  assert.equal(text('hud-exp-status'), 'Names: 3 to 24 letters, digits, spaces and _ . - ! ? #');
  assert.equal(name.value, 'Moon base', 'the field shows the saved name again');
  // Reset to standard: the first press asks, the second resets.
  rowItem('Gravity').right();
  const resetBtn = page.actions.children[0];
  resetBtn.click();
  assert.equal(resetBtn.textContent, 'Reset to standard? Press again');
  assert.equal(store.get(store.lastUsed()).values.gravity, 110, 'not yet');
  resetBtn.click();
  assert.deepEqual(store.get(store.lastUsed()).values, {});
  assert.equal(resetBtn.textContent, 'Reset to standard');
  // Delete: the first press asks, the second deletes (on the account) and shows the neighbour.
  press('Delete');
  assert.equal(buttons()[3].textContent, 'Delete? Press again');
  assert.equal(store.presets().length, 2);
  press('Delete?');
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(store.presets().map((p) => p.name), ['Low gravity #2']);
  assert.equal(text('hud-exp-picker-value'), 'Low gravity #2', 'the one before it');
  // Offline, a delete is refused and says so.
  E.server.online = false;
  press('Delete');
  press('Delete?');
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(store.presets().length, 1);
  assert.equal(text('hud-exp-status'), 'Deleting a preset needs a connection');
  page.disarm();
  assert.equal(find('hud-exp-status')[0].hidden, true, 'leaving the tab clears the line');
});

test('Preset editor: the account cap says so on the page; the training context says when the rules apply; a match shows its rules only', async () => {
  const E = await editorPage('training');
  for (let i = 0; i < R.MAX_PRESETS; i++) E.press('New');
  assert.equal(E.store.presets().length, R.MAX_PRESETS);
  E.press('New');
  assert.equal(E.store.presets().length, R.MAX_PRESETS);
  assert.equal(E.text('hud-exp-status'), '10 presets at most: delete one first');
  assert.equal(E.find('hud-exp-live')[0].hidden, false);
  assert.equal(E.text('hud-exp-live'), 'Free play restarts with these rules when you go back');
  E.opts.context = 'menu';
  E.page.refresh();
  assert.equal(E.find('hud-exp-live')[0].hidden, true);
  E.opts.context = 'match';
  E.page.refresh();
  assert.equal(E.editor.hidden, true);
  const match = E.find('hud-exp-match')[0];
  assert.equal(match.hidden, false);
  assert.equal(match.textContent, 'Low gravity · Gravity 50%');
  assert.equal(E.page.items().length, 1, 'only the switch to focus');
});
