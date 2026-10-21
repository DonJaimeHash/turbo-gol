// Dynamic resolution controller (node --test tests/dynamic-resolution.test.mjs): refresh estimate,
// quick probes down, slow steps up, no oscillation at a load just above a step, CPU-bound frames
// left alone, ignored stalls and the GPU-time rules. The controller is pure, so a frame is just
// (interval, gpu ms).
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

const { DynamicResolution } = await import('../src/render/dynamicResolution.ts');

const HZ60 = 1000 / 60;
const HZ144 = 1000 / 144;

/**
 * Run `seconds` of a vsync'd display: frame `i` costs `gpu(scale)` ms of GPU time (and at least
 * `cpu(i)` ms of CPU time) and is presented on the next vsync. Returns the scale changes as
 * [time s, scale], the end time and the seconds spent below full resolution.
 */
function run(dr, seconds, refreshMs, gpu, opts = {}) {
  const cpu = opts.cpu ?? (() => 0);
  const changes = [];
  let t = opts.t0 ?? 0;
  let below = 0;
  let i = 0;
  const end = t + seconds;
  while (t < end) {
    const g = gpu(dr.scale);
    const busy = Math.max(g, cpu(i++));
    const interval = Math.max(1, Math.ceil(busy / refreshMs - 1e-9)) * refreshMs;
    t += interval / 1000;
    if (dr.scale < 1) below += interval / 1000;
    if (dr.update(interval, opts.timing ? g : Number.NaN)) changes.push([+t.toFixed(2), dr.scale]);
  }
  return { changes, t, below };
}

/** 60 Hz with a light load for 2 s: the refresh is known and the settle time is over. */
function warm(dr, timing = false) {
  return run(dr, 2, HZ60, () => 5, { timing }).t;
}

/** A GPU-bound load that only fits a 60 Hz frame at scale 0.6 (the cost scales with the pixels). */
const heavy = (s) => 45 * s * s;

test('on-time frames keep full resolution and the refresh estimate follows the display', () => {
  const dr = new DynamicResolution(0.6);
  const { changes } = run(dr, 20, HZ144, () => 3);
  assert.deepEqual(changes, []);
  assert.equal(dr.scale, 1);
  assert.ok(Math.abs(dr.refreshMs - HZ144) < 0.15, `refresh ${dr.refreshMs} (0.25 ms bins)`);
});

test('a GPU-bound load steps down within about half a second until frames fit', () => {
  const dr = new DynamicResolution(0.6);
  const t0 = warm(dr);
  const { changes } = run(dr, 10, HZ60, heavy, { t0 });
  assert.ok(changes.length >= 1, 'stepped down');
  assert.ok(changes[0][0] - t0 < 0.8, `first step after ${(changes[0][0] - t0).toFixed(2)} s`);
  assert.equal(changes[0][1], 0.9);
  assert.equal(changes.at(-1)[1] <= 0.65, true, JSON.stringify(changes));
  for (const [, s] of changes) assert.ok(s >= 0.6 - 1e-9, 'never below the tier minimum');
  assert.ok(changes.find(([, s]) => s === 0.6)[0] - t0 < 3, 'at 0.6 within 3 s');
});

test('headroom steps up slowly: 0.05 every 3 s', () => {
  const dr = new DynamicResolution(0.6);
  let t = warm(dr);
  t = run(dr, 4, HZ60, heavy, { t0: t }).t;
  assert.equal(dr.scale, 0.6);
  const { changes } = run(dr, 10, HZ60, () => 5, { t0: t });
  assert.deepEqual(
    changes.map(([, s]) => s),
    [0.65, 0.7, 0.75],
  );
  for (let i = 1; i < changes.length; i++) assert.ok(changes[i][0] - changes[i - 1][0] >= 2.9, 'one step per 3 s');
});

test('a load just above a step settles on the step below; the tries back off (no oscillation)', () => {
  const dr = new DynamicResolution(0.6);
  // 24 ms at full resolution: 0.8 fits a 60 Hz frame, 0.85 does not.
  const { changes, t } = run(dr, 300, HZ60, (s) => 24 * s * s);
  const late = changes.filter(([at]) => at > 100);
  for (const [, s] of late) assert.ok(s >= 0.8 - 1e-9 && s <= 0.85 + 1e-9, `scale ${s} left 0.8..0.85`);
  const tries = late.filter(([, s]) => s > 0.8 + 1e-9).length;
  assert.ok(tries <= 5, `${tries} tries of 0.85 in 200 s`);
  assert.equal(dr.scale, 0.8);
  // Once the load drops, the scale climbs back to full resolution.
  const after = run(dr, 90, HZ60, () => 6, { t0: t });
  assert.equal(dr.scale, 1, JSON.stringify(after.changes));
});

test('CPU-bound frames: one probe, back to full resolution, then left alone', () => {
  const dr = new DynamicResolution(0.6);
  const t0 = warm(dr);
  // 30 fps whatever the scale (a CPU limit or a 30 fps power saver).
  const { changes, below } = run(dr, 120, HZ60, () => 3, { t0, cpu: () => 30 });
  assert.equal(dr.scale, 1);
  assert.ok(below < 3, `${below.toFixed(1)} s below full resolution`);
  assert.ok(changes.filter(([, s]) => s === 1).length === 1, `one probe: ${JSON.stringify(changes)}`);
  assert.ok(dr.refreshMs > 30, `the refresh estimate follows the slower frames: ${dr.refreshMs}`);
});

test('CPU-bound at a high refresh with jitter (1-3 vsyncs a frame): full resolution almost all the time', () => {
  const HZ165 = 1000 / 165;
  const dr = new DynamicResolution(0.6);
  // Mostly two vsyncs, now and then one or three, whatever the scale.
  const cpu = (i) => (i % 23 === 0 ? 5 : i % 7 === 0 ? 14 : 10);
  const { below } = run(dr, 300, HZ165, () => 0.3, { cpu });
  assert.equal(dr.scale, 1);
  assert.ok(below < 10, `${below.toFixed(1)} s of 300 below full resolution`);
});

test('jittery, timer-paced frames with a few very short intervals do not count as late', () => {
  const dr = new DynamicResolution(0.6);
  // 16.7 ms +- 2 ms (a loop paced by a timer or a jittery vsync), 3 % of the intervals 1-3 ms apart.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 60 * 120; i++) {
    const interval = rnd() < 0.03 ? 1 + 2 * rnd() : 14.7 + 4 * rnd();
    dr.update(interval, Number.NaN);
  }
  assert.equal(dr.scale, 1);
  assert.ok(dr.refreshMs > 14, `refresh ${dr.refreshMs}`);
});

test('stalls and a throttled background tab are ignored', () => {
  const dr = new DynamicResolution(0.6);
  warm(dr);
  for (let i = 0; i < 200; i++) assert.equal(dr.update(1000, Number.NaN), false, 'hidden tab at 1 fps');
  for (let i = 0; i < 200; i++) assert.equal(dr.update(333, Number.NaN), false, 'background tab at 3 fps');
  assert.equal(dr.scale, 1);
  assert.ok(Math.abs(dr.refreshMs - HZ60) < 0.15, 'the refresh estimate is untouched');
  assert.equal(dr.update(0, Number.NaN), false);
  assert.equal(dr.update(Number.NaN, Number.NaN), false);
  assert.equal(dr.update(-5, Number.NaN), false);
});

test('with GPU timing: late frames with an idle GPU never step down; a busy GPU does', () => {
  const dr = new DynamicResolution(0.6);
  const t0 = warm(dr, true);
  const idle = run(dr, 10, HZ60, () => 3, { t0, cpu: () => 30, timing: true });
  assert.deepEqual(idle.changes, []);
  const busy = run(dr, 2, HZ60, heavy, { t0: idle.t, timing: true });
  assert.ok(busy.changes.length > 0 && busy.changes[0][1] === 0.9, JSON.stringify(busy.changes));
});

test('with GPU timing: no step up when the next step would not fit', () => {
  const dr = new DynamicResolution(0.6);
  let t = warm(dr, true);
  t = run(dr, 4, HZ60, heavy, { t0: t, timing: true }).t;
  assert.equal(dr.scale, 0.6);
  // On time at 0.6, but 0.65 would need 14.5 * (0.65 / 0.6)^2 = 17 ms > 80 % of the refresh.
  const tight = run(dr, 20, HZ60, (s) => (14.5 * s * s) / 0.36, { t0: t, timing: true });
  assert.deepEqual(tight.changes, []);
  const roomy = run(dr, 4, HZ60, () => 6, { t0: tight.t, timing: true });
  assert.deepEqual(
    roomy.changes.map(([, s]) => s),
    [0.65],
  );
});

test('a late share between 5 % and a quarter moves nothing (hysteresis)', () => {
  const dr = new DynamicResolution(0.6);
  let t = warm(dr);
  t = run(dr, 4, HZ60, heavy, { t0: t }).t;
  assert.equal(dr.scale, 0.6);
  // One frame in eight misses a vsync (12.5 %): not enough to step down, too many to step up.
  const { changes } = run(dr, 60, HZ60, () => 5, { t0: t, cpu: (i) => (i % 8 === 0 ? 20 : 0) });
  assert.deepEqual(changes, []);
});

test('minimum 1 never moves; reset goes back to full resolution', () => {
  const fixed = new DynamicResolution(1);
  run(fixed, 10, HZ60, () => 40);
  assert.equal(fixed.scale, 1);

  const dr = new DynamicResolution(0.6);
  let t = warm(dr);
  t = run(dr, 6, HZ60, heavy, { t0: t }).t;
  assert.equal(dr.scale, 0.6);
  dr.reset(0.7);
  assert.equal(dr.scale, 1);
  t = run(dr, 6, HZ60, heavy, { t0: t }).t;
  assert.ok(dr.scale >= 0.7 - 1e-9, `the new minimum: ${dr.scale}`);
  dr.reset(1);
  run(dr, 6, HZ60, heavy, { t0: t });
  assert.equal(dr.scale, 1);
});

test('every scale is on the 0.05 grid', () => {
  const dr = new DynamicResolution(0.6);
  const { changes } = run(dr, 120, HZ60, (s) => 21 * s * s);
  assert.ok(changes.length > 0);
  for (const [, s] of changes) assert.equal(Math.round(s * 20) / 20, s, `${s}`);
});
