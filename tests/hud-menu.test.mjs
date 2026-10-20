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

const { formatSettingValue, stepDecimals, stepSettingValue, MENU_CONTROL_ROWS, DIFFICULTIES, GAME_MODES, modeInfo, formatNetStats } = await import('../src/render/Hud.ts');
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
