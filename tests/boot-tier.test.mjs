// The boot tier (node --test tests/boot-tier.test.mjs): super low for the 1 GB Android TV of
// docs/visuals/REWORK.md "Super low", the precedence of the URL, the tab's recovery, the player's
// choice and auto, and that a tier the session runs on its own is never saved. bootTier.ts and
// quality.ts are pure (no three, no DOM).
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

const { autoSuperlow, bootTier, needsGpuProbe, tierPrefsAfter, SLOW_TV_GPU, SUPERLOW_MEMORY_GB } = await import('../src/render/bootTier.ts');
const { QUALITIES, startingQuality } = await import('../src/render/quality.ts');

const TV = { deviceMemory: 1, pointer: 'none', gpu: 'Mali-G31' };
const DESKTOP = { deviceMemory: 8, pointer: 'fine', gpu: '' };
const PHONE = { deviceMemory: 4, pointer: 'coarse', gpu: '' };

test('auto: super low on the TV, on 1 GB, and on a TV with a slow GPU; never from the GPU list on a phone or a computer', () => {
  assert.equal(autoSuperlow(TV), 'tv-gpu');
  assert.equal(autoSuperlow({ ...TV, gpu: '' }), 'memory', 'the same TV without the probe: its 1 GB');
  assert.equal(autoSuperlow({ deviceMemory: 1, pointer: 'fine', gpu: '' }), 'memory', '1 GB even with a mouse');
  assert.equal(autoSuperlow({ deviceMemory: 0.5, pointer: 'coarse', gpu: '' }), 'memory');
  assert.equal(autoSuperlow({ deviceMemory: 2, pointer: 'none', gpu: 'ARM Mali-G52 MC2' }), 'tv-gpu', 'a Chromecast-class box');
  assert.equal(autoSuperlow({ deviceMemory: 2, pointer: 'none', gpu: 'Mali-G51' }), 'tv-gpu');
  assert.equal(autoSuperlow({ deviceMemory: 2, pointer: 'none', gpu: 'Mali-T860 MP2' }), 'tv-gpu');
  assert.equal(autoSuperlow({ deviceMemory: 2, pointer: 'none', gpu: 'PowerVR Rogue GE8320' }), 'tv-gpu');
  assert.equal(autoSuperlow({ deviceMemory: 2, pointer: 'none', gpu: 'Mali-G57 MC2' }), null, 'a TV with a GPU off the list');
  assert.equal(autoSuperlow({ deviceMemory: 4, pointer: 'coarse', gpu: 'Mali-G52' }), null, 'a phone keeps low');
  assert.equal(autoSuperlow({ deviceMemory: 8, pointer: 'fine', gpu: 'Mali-G31' }), null, 'a computer keeps its tier');
  assert.equal(autoSuperlow(DESKTOP), null);
  assert.equal(autoSuperlow(PHONE), null);
  assert.equal(autoSuperlow({ deviceMemory: undefined, pointer: 'fine', gpu: '' }), null, 'Safari / Firefox / an insecure context: no deviceMemory, not small');
  assert.equal(autoSuperlow({ deviceMemory: undefined, pointer: 'none', gpu: '' }), null);
  assert.equal(SUPERLOW_MEMORY_GB, 1);
  assert.ok(!SLOW_TV_GPU.test('Mali-G310'), 'whole model names');
  assert.ok(!SLOW_TV_GPU.test('Mali-G76'));
  assert.ok(SLOW_TV_GPU.test('ARM / Mali-G31'));
  assert.equal(needsGpuProbe('none'), true, 'only TVs are probed');
  assert.equal(needsGpuProbe('fine'), false);
  assert.equal(needsGpuProbe('coarse'), false);
});

test('precedence: the URL and the tab recovery, then the player, then auto, then the saved default', () => {
  const unset = { quality: 'high', qualitySet: false };
  assert.deepEqual(bootTier(unset, TV, null), { tier: 'superlow', reason: 'tv-gpu' }, 'the TV with fresh site data');
  assert.deepEqual(bootTier({ quality: 'high', qualitySet: true }, TV, null), { tier: 'high', reason: 'chosen' }, "the player's choice wins over auto");
  assert.deepEqual(bootTier({ quality: 'high', qualitySet: true }, TV, 'hash'), { tier: 'superlow', reason: 'hash' }, '#superlow wins over everything');
  assert.deepEqual(bootTier({ quality: 'ultra', qualitySet: true }, DESKTOP, 'recover'), { tier: 'superlow', reason: 'recover' });
  assert.deepEqual(bootTier(unset, DESKTOP, null), { tier: 'high', reason: 'default' });
  assert.deepEqual(bootTier({ quality: 'low', qualitySet: false }, PHONE, null), { tier: 'low', reason: 'default' });
  assert.deepEqual(bootTier({ quality: 'superlow', qualitySet: true }, DESKTOP, null), { tier: 'superlow', reason: 'chosen' });
  // A GPU of this device fell to super low (tierGuard.ts readSuperlowBoot): a ceiling, so it caps
  // the player's tier too, below the URL and the tab's recovery (their own reasons).
  assert.deepEqual(bootTier({ quality: 'low', qualitySet: true }, DESKTOP, null, true), { tier: 'superlow', reason: 'ceiling' });
  assert.deepEqual(bootTier(unset, PHONE, null, true), { tier: 'superlow', reason: 'ceiling' });
  assert.deepEqual(bootTier(unset, TV, null, true), { tier: 'superlow', reason: 'ceiling' });
  assert.deepEqual(bootTier({ quality: 'low', qualitySet: true }, DESKTOP, 'hash', true), { tier: 'superlow', reason: 'hash' });
  assert.deepEqual(bootTier({ quality: 'low', qualitySet: true }, DESKTOP, null, false), { tier: 'low', reason: 'chosen' }, 'the pick tried across a reload (the caller passes false)');
  // Garbage in the prefs never yields an unknown tier.
  for (const q of [7, 'basura', null, undefined]) assert.ok(QUALITIES.includes(bootTier({ quality: q, qualitySet: true }, DESKTOP, null).tier), String(q));
});

test('after init: super low is never raised; a weak backend lowers only the tiers above low', () => {
  const webgl2 = { webgpu: false, compatibilityMode: false, deviceMemory: 1 };
  assert.equal(startingQuality('superlow', false, webgl2), 'superlow');
  assert.equal(startingQuality('superlow', true, webgl2), 'superlow');
  assert.equal(startingQuality('high', false, webgl2), 'low');
  assert.equal(startingQuality('high', true, webgl2), 'high', 'a chosen tier stays');
});

test('the prefs keep the player\'s pick: a tier the session runs on its own is never saved', () => {
  const chosenHigh = { quality: 'high', qualitySet: true };
  for (const reason of ['hash', 'recover', 'memory', 'tv-gpu', 'weak', 'ceiling', 'nofloat', 'fallback']) {
    assert.deepEqual(tierPrefsAfter(chosenHigh, { kind: 'run', tier: 'superlow', reason }), chosenHigh, reason);
  }
  const unset = { quality: 'high', qualitySet: false };
  assert.deepEqual(tierPrefsAfter(unset, { kind: 'run', tier: 'superlow', reason: 'tv-gpu' }), unset, 'auto super low is decided again next time');
  assert.deepEqual(tierPrefsAfter(chosenHigh, { kind: 'pick', tier: 'superlow' }), { quality: 'superlow', qualitySet: true }, 'a pick is saved');
  assert.deepEqual(tierPrefsAfter(unset, { kind: 'pick', tier: 'low' }), { quality: 'low', qualitySet: true });
});

const { gateTierPrefs } = await import('../src/render/bootTier.ts');
const { menuQualities, nextQuality, lowerQuality } = await import('../src/render/quality.ts');

test('Super low is a pick for unlocked players: a locked saved pick reads as Performance, not chosen; nothing else changes', () => {
  const picked = { quality: 'superlow', qualitySet: true, theme: 'night', mode: '2v2' };
  const gated = gateTierPrefs(picked, false);
  assert.deepEqual(gated, { quality: 'low', qualitySet: false, theme: 'night', mode: '2v2' }, 'the other prefs are kept');
  assert.equal(gateTierPrefs(picked, true), picked, 'unlocked: the same object');
  for (const q of ['low', 'high', 'ultra']) {
    const p = { quality: q, qualitySet: true };
    assert.equal(gateTierPrefs(p, false), p, `${q} is everyone's`);
  }
  const unset = { quality: 'superlow', qualitySet: false };
  assert.equal(gateTierPrefs(unset, false), unset, 'not a pick (an old default): auto decides anyway');
  // Not chosen: the TV auto rule still gives the weak TV super low, the desktop gets Performance.
  assert.deepEqual(bootTier(gated, TV, null), { tier: 'superlow', reason: 'tv-gpu' }, 'a guest on the 1 GB TV still starts on super low');
  assert.deepEqual(bootTier(gated, DESKTOP, null), { tier: 'low', reason: 'default' });
  // The URL, the tab's recovery and a ceiling come before the prefs: untouched by the gate.
  assert.deepEqual(bootTier(gated, DESKTOP, 'hash'), { tier: 'superlow', reason: 'hash' });
  assert.deepEqual(bootTier(gated, DESKTOP, 'recover'), { tier: 'superlow', reason: 'recover' });
  assert.deepEqual(bootTier(gated, DESKTOP, null, true), { tier: 'superlow', reason: 'ceiling' });
  // The safety net still falls into super low for everyone.
  assert.equal(lowerQuality('low'), 'superlow');
});

test("tierPrefsAfter 'lock': a super low pick becomes Performance, not chosen; any other prefs stay", () => {
  assert.deepEqual(tierPrefsAfter({ quality: 'superlow', qualitySet: true }, { kind: 'lock' }), { quality: 'low', qualitySet: false });
  const high = { quality: 'high', qualitySet: true };
  assert.equal(tierPrefsAfter(high, { kind: 'lock' }), high);
  const unset = { quality: 'low', qualitySet: false };
  assert.equal(tierPrefsAfter(unset, { kind: 'lock' }), unset);
});

test('menuQualities / nextQuality: Super low listed only when unlocked; the quality key cycles the list', () => {
  assert.deepEqual(menuQualities(true), QUALITIES);
  assert.deepEqual(menuQualities(false), ['low', 'high', 'ultra']);
  const locked = menuQualities(false);
  assert.equal(nextQuality('low', locked), 'high');
  assert.equal(nextQuality('ultra', locked), 'low', 'wraps past super low');
  assert.equal(nextQuality('superlow', locked), 'low', 'a device on super low by itself steps to the first listed tier');
  assert.equal(nextQuality('ultra'), 'superlow', 'every tier by default');
  assert.equal(nextQuality('high', []), 'high');
});

const { FrameStats } = await import('../src/render/frameStats.ts');

test('#diag frame statistics: 1 s min / mean, 5 s mean, long frames after the warm-up, CPU per frame', () => {
  const fs = new FrameStats();
  let t = 0;
  // 2 s at 30 fps before the warm-up ends: no long-frame counts.
  for (let i = 0; i < 60; i++) fs.frame((t += 1000 / 30));
  fs.markWarm();
  // 6 s at 30 fps with one 120 ms hitch and one 60 ms frame, 1 ms of prediction and 0.5 ms of bots each.
  for (let i = 0; i < 180; i++) {
    fs.add('pred', i === 100 ? 6 : 1);
    fs.add('bots', 0.5);
    t += i === 90 ? 120 : i === 150 ? 60 : 1000 / 30;
    fs.frame(t);
  }
  const s = fs.snapshot();
  assert.equal(s.over100, 1);
  assert.equal(s.over50, 2);
  assert.ok(Math.abs(s.fpsAvg5 - 30) < 2, `5 s mean ${s.fpsAvg5}`);
  assert.ok(s.fpsAvg1 > 25 && s.fpsAvg1 <= 30.5, `1 s mean ${s.fpsAvg1}`);
  assert.ok(Math.abs(s.cpu.bots - 0.5) < 1e-9, `bots ${s.cpu.bots}`);
  assert.ok(s.cpu.pred >= 1 && s.cpu.pred < 1.3, `pred ${s.cpu.pred}`);
  assert.equal(s.cpu.step, 0);
  assert.ok(s.fpsMin1 <= s.fpsAvg1);
});
