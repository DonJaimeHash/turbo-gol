// The engine-sound model (src/audio/engine.ts): rpm through the gears, shifts, free revs, load.
// Run: node --test tests/engine-audio.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const E = await import('../src/audio/engine.ts');
const DT = 1 / 60;

/** Drive the model for `seconds` with speed(t) and the given inputs; returns the per-step samples. */
function run(model, seconds, speedAt, throttle, grounded = true, boosting = false, t0 = 0) {
  const out = [];
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    const t = t0 + i * DT;
    model.step(DT, speedAt(t), throttle, grounded, boosting);
    out.push({ t, rpm: model.rpm, gear: model.gear, load: model.load, shifted: model.shifted });
  }
  return out;
}

test('idles at IDLE_RPM in 1st with no load when the car stands still', () => {
  const m = new E.EngineModel();
  const s = run(m, 1, () => 0, 0);
  const last = s[s.length - 1];
  assert.equal(last.rpm, E.IDLE_RPM);
  assert.equal(last.gear, 0);
  assert.equal(last.load, 0);
});

test('accelerating with the throttle: the rpm climbs in each gear and drops on every upshift', () => {
  const m = new E.EngineModel();
  // The throttle-only speed curve: v = 1410 (1 - e^-1.13t).
  const s = run(m, 5, (t) => 1410 * (1 - Math.exp(-1.13 * t)), 1);
  const shifts = s.filter((x) => x.shifted);
  assert.equal(shifts.length, 3, 'three upshifts on the way to 1410 uu/s');
  assert.equal(s[s.length - 1].gear, 3, '4th gear at the throttle-limited top speed');
  for (const sh of shifts) {
    const i = s.indexOf(sh);
    const peak = s[i - 1].rpm;
    const after = Math.min(...s.slice(i, i + 20).map((x) => x.rpm));
    assert.ok(peak - after > 1200, `shift at ${sh.t.toFixed(2)} s drops ${Math.round(peak - after)} rpm`);
  }
  for (const x of s) assert.ok(x.rpm >= E.IDLE_RPM && x.rpm <= E.REDLINE_RPM && Number.isFinite(x.load));
  const cruise = s[s.length - 1];
  assert.ok(cruise.rpm > 3900 && cruise.rpm < 5000, `cruise rpm ${Math.round(cruise.rpm)} (mid-range, no droning redline)`);
  assert.ok(cruise.load < 0.75, `cruising at top speed is a light load (${cruise.load.toFixed(2)})`);
  assert.ok(Math.max(...s.slice(0, 30).map((x) => x.load)) > 0.9, 'pulling away is a full load');
});

test('boost reaches 5th gear with full load', () => {
  const m = new E.EngineModel();
  const s = run(m, 3, (t) => Math.min(2300, 1410 + 900 * t), 1, true, true);
  const last = s[s.length - 1];
  assert.equal(last.gear, 4);
  assert.equal(last.load, 1);
  assert.ok(last.rpm > 5500);
});

test('slowing down shifts down without hunting at a gear boundary', () => {
  const m = new E.EngineModel();
  run(m, 3, () => 1300, 1); // settle in 4th
  assert.equal(m.gear, 3);
  // Hover just under the 4th gear start (1250): inside the hysteresis band, no shift either way.
  const hover = run(m, 1, (t) => 1230 + 10 * Math.sin(t * 20), 0);
  assert.ok(hover.every((x) => x.gear === 3), 'stays in 4th inside the hysteresis band');
  run(m, 2, (t) => Math.max(0, 1100 - 600 * t), 0);
  assert.equal(m.gear, 0, 'back in 1st at a standstill');
});

test('airborne: the throttle revs the engine freely, the gear is kept for the landing', () => {
  const m = new E.EngineModel();
  run(m, 3, () => 900, 1);
  const gear = m.gear;
  const air = run(m, 1.5, () => 900, 1, false);
  assert.ok(Math.abs(air[air.length - 1].rpm - E.FREE_REV_RPM) < 1, 'revs to FREE_REV_RPM');
  assert.equal(m.gear, gear);
  const off = run(m, 1.5, () => 900, 0, false);
  assert.equal(off[off.length - 1].rpm, E.IDLE_RPM, 'falls back to idle off the throttle');
});

test('a standstill with the throttle pressed (pushing a wall) revs a little above idle', () => {
  const m = new E.EngineModel();
  const s = run(m, 1, () => 0, 1);
  const rpm = s[s.length - 1].rpm;
  assert.ok(rpm > E.IDLE_RPM + 1000 && rpm < 3000, `clutch slip rpm ${Math.round(rpm)}`);
});

test('a throttle against the direction of travel is the brake: no load, then reverse drives', () => {
  const m = new E.EngineModel();
  run(m, 3, () => 1300, 1);
  const brake = run(m, 0.3, (t) => 1300 - 3500 * t, -1);
  assert.ok(brake.every((x) => x.load === 0), 'braking from forward speed is no load');
  const reverse = run(m, 1, (t) => -Math.min(500, 400 * t), -1);
  assert.ok(reverse[reverse.length - 1].load > 0.5, 'reversing with the throttle back is a load again');
});

test('reset() returns to idle', () => {
  const m = new E.EngineModel();
  run(m, 2, () => 1400, 1);
  m.reset();
  assert.equal(m.rpm, E.IDLE_RPM);
  assert.equal(m.gear, 0);
  assert.equal(m.load, 0);
});
