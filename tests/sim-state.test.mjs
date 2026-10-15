// Node tests for the full-state save / load API of the RocketSim wasm bridge (rollback netcode):
// rs_save_state / rs_load_state / rs_state_size_max / rs_state_hash / rs_set_controls_packed and
// RocketSim.load({ wasmModule }) (the workerd instantiation path). Run from the project root:
//   node --test tests/sim-state.test.mjs     (needs src/sim/wasm/rocketsim.{js,wasm}: npm run build:wasm)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Node strips TypeScript types natively but does not add extensions to bare relative imports.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (relative && err && err.code === 'ERR_MODULE_NOT_FOUND') {
        if (!/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + '.ts', context);
        if (specifier.endsWith('.js')) return nextResolve(specifier.slice(0, -3) + '.ts', context);
      }
      throw err;
    }
  },
});

const { RocketSim } = await import('../src/sim/RocketSimBridge.ts');
const T = await import('../src/sim/types.ts');
const { buildArenaMesh } = await import('../src/sim/arenaMesh.ts');

const mesh = buildArenaMesh().physics;
const WASM_PATH = fileURLToPath(new URL('../src/sim/wasm/rocketsim.wasm', import.meta.url));
const { MAX_STATE_BYTES, PACKED_INPUT_BYTES, H_GOAL_COUNT, H_BUMP_COUNT } = T;

/** FNV-1a 32 as specified for rs_state_hash (offset basis 0x811c9dc5, prime 0x01000193). */
function fnv1a32(bytes, len = bytes.length) {
  let h = 0x811c9dc5;
  for (let i = 0; i < len; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** xorshift32 in [0, 1): deterministic inputs for the replays. */
function rng(seed) {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/** One packed frame (numCars * 6 int8) per tick; every control is held for `hold` ticks. */
function genFrames(numTicks, numCars, seed, hold = 15) {
  const r = rng(seed);
  const frames = [];
  let cur = null;
  for (let t = 0; t < numTicks; t++) {
    if (t % hold === 0) {
      cur = new Int8Array(numCars * PACKED_INPUT_BYTES);
      for (let i = 0; i < numCars; i++) {
        const o = i * PACKED_INPUT_BYTES;
        cur[o] = r() < 0.7 ? 127 : Math.round((r() * 2 - 1) * 127); // mostly full throttle
        for (let k = 1; k < 5; k++) cur[o + k] = Math.round((r() * 2 - 1) * 127);
        cur[o + 5] = (r() < 0.08 ? T.BTN_JUMP : 0) | (r() < 0.4 ? T.BTN_BOOST : 0) | (r() < 0.1 ? T.BTN_HANDBRAKE : 0);
      }
    }
    frames.push(cur);
  }
  return frames;
}

function runFrames(sim, frames, from, to, numCars) {
  for (let t = from; t < to; t++) {
    sim.setControlsPacked(frames[t], numCars);
    sim.step(1);
  }
  sim.sync();
}

/**
 * Like runFrames, syncing every tick (so every event is counted), with an optional per-tick
 * override that steers every car at the ball (recorded into `frames` on the first pass so the
 * replay applies byte-identical inputs).
 */
function playFrames(sim, frames, from, to, numCars, chase) {
  const buf = sim.buf;
  for (let t = from; t < to; t++) {
    let f = frames[t];
    if (chase && !f.chased) {
      f = new Int8Array(f);
      const bx = buf[T.BALL_OFFSET + T.B_POS];
      const by = buf[T.BALL_OFFSET + T.B_POS + 1];
      for (let k = 0; k < numCars; k++) {
        const o = sim.carOffset(k);
        const dx = bx - buf[o + T.C_POS];
        const dy = by - buf[o + T.C_POS + 1];
        const fx = buf[o + T.C_ROT];
        const fy = buf[o + T.C_ROT + 1];
        const cross = fx * dy - fy * dx;
        f[k * PACKED_INPUT_BYTES] = 127;
        f[k * PACKED_INPUT_BYTES + 1] = cross > 0 ? 127 : -127;
        f[k * PACKED_INPUT_BYTES + 5] = ((t / 120 + k) % 8 < 2 ? T.BTN_BOOST : 0) | ((t + k * 37) % 400 === 0 ? T.BTN_JUMP : 0);
      }
      f.chased = true;
      frames[t] = f;
    }
    sim.setControlsPacked(f, numCars);
    sim.step(1);
    sim.sync();
  }
}

/** Fresh arena with `perTeam` cars per team (blue first), at a seeded kickoff; returns the ids. */
function setupArena(sim, perTeam, seed, { contactHeavy = false } = {}) {
  sim.createArena();
  sim.events.onGoal = undefined;
  sim.events.onBump = undefined;
  sim.events.onBallHit = undefined;
  const ids = [];
  for (let i = 0; i < perTeam; i++) ids.push(sim.addCar(T.Team.Blue, i % 6));
  for (let i = 0; i < perTeam; i++) ids.push(sim.addCar(T.Team.Red, (i + 3) % 6));
  sim.resetKickoff(seed);
  if (contactHeavy) {
    // Everyone aimed at the ball from close by with full boost: car-ball, car-car and car-floor
    // contacts (Bullet manifolds) are exercised right from the first ticks.
    for (let k = 0; k < ids.length; k++) {
      const ang = (k / ids.length) * Math.PI * 2;
      sim.setCarState(ids[k], [Math.cos(ang) * 700, Math.sin(ang) * 700, 17], [ang + Math.PI, 0, 0]);
      sim.setCarBoost(ids[k], 100);
    }
  }
  sim.sync();
  return ids;
}

async function makeSim(opts) {
  const sim = await RocketSim.load(opts);
  sim.initArena(mesh);
  return sim;
}

const sim = await makeSim();

/** Byte-exact comparison of two Float32Array copies, ignoring the wrapper's monotonic event counters. */
function assertBuffersIdentical(a, b, what) {
  assert.equal(a.length, b.length);
  const ua = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const ub = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  const skip = new Set([H_GOAL_COUNT, H_BUMP_COUNT]);
  for (let i = 0; i < a.length; i++) {
    if (skip.has(i)) continue;
    for (let k = 0; k < 4; k++) {
      assert.equal(ua[i * 4 + k], ub[i * 4 + k], `${what}: float ${i} differs (${a[i]} vs ${b[i]})`);
    }
  }
}

/**
 * The round trip of test (a): play `saveAt` ticks, save, play `replay` more -> hash A; load, replay
 * the same inputs -> hash B. Returns the blob length and the hashes.
 */
function roundTrip(s, { perTeam = 1, seed = 7, inputSeed = 1, saveAt = 300, replay = 120, contactHeavy = false }) {
  const ids = setupArena(s, perTeam, seed, { contactHeavy });
  const n = ids.length;
  const frames = genFrames(saveAt + replay, n, inputSeed);
  let hits = 0;
  let goals = 0;
  s.events.onBallHit = () => hits++;
  s.events.onGoal = () => goals++;
  playFrames(s, frames, 0, saveAt, n, contactHeavy);
  const hitsBeforeSave = hits;

  const blob = new Uint8Array(MAX_STATE_BYTES);
  const len = s.saveState(blob);
  assert.ok(len > 0 && len <= s.stateSizeMax(), `blob length ${len} within stateSizeMax ${s.stateSizeMax()}`);
  const hashSaved = s.stateHash();
  assert.equal(hashSaved, fnv1a32(blob, len), 'rs_state_hash is FNV-1a 32 of the blob bytes');
  assert.equal(s.tickCount, saveAt);
  const goalsSaved = s.buf[H_GOAL_COUNT];
  const bumpsSaved = s.buf[H_BUMP_COUNT];
  const hitsSaved = hits;

  playFrames(s, frames, saveAt, saveAt + replay, n, contactHeavy);
  const hashA = s.stateHash();
  const bufA = new Float32Array(s.buf);
  const hitsA = hits - hitsSaved;
  const goalsA = s.buf[H_GOAL_COUNT] - goalsSaved;
  const bumpsA = s.buf[H_BUMP_COUNT] - bumpsSaved;

  const hitsBeforeLoad = hits;
  s.loadState(blob, len);
  assert.equal(hits, hitsBeforeLoad, 'loadState itself fires no onBallHit');
  assert.equal(s.tickCount, saveAt, 'tick count restored');
  assert.equal(s.stateHash(), hashSaved, 'hash right after the load == hash at save time');
  // save(load(blob)) reproduces the blob byte for byte.
  const blob2 = new Uint8Array(MAX_STATE_BYTES);
  const len2 = s.saveState(blob2);
  assert.equal(len2, len);
  assert.equal(Buffer.compare(blob2.subarray(0, len), blob.subarray(0, len)), 0, 'save after load reproduces the blob');
  const goalsLoaded = s.buf[H_GOAL_COUNT];
  const bumpsLoaded = s.buf[H_BUMP_COUNT];

  playFrames(s, frames, saveAt, saveAt + replay, n, false); // frames already recorded: replayed verbatim
  const hashB = s.stateHash();
  const bufB = new Float32Array(s.buf);
  assert.equal(hashB, hashA, `replay hash (${hashB}) == uninterrupted hash (${hashA})`);
  assertBuffersIdentical(bufA, bufB, 'state buffer after replay');
  assert.equal(hits - hitsBeforeLoad, hitsA, 'the replay reports the same ball hits');
  assert.equal(s.buf[H_GOAL_COUNT] - goalsLoaded, goalsA, 'the replay re-counts the same goals');
  assert.equal(s.buf[H_BUMP_COUNT] - bumpsLoaded, bumpsA, 'the replay re-counts the same bumps');
  // Whole-run contact counts (before the save too: that history is what fills Bullet's caches).
  return { len, hashA, hits: hitsBeforeSave + hitsA, windowHits: hitsA, goals, bumps: s.buf[H_BUMP_COUNT] };
}

test('a. round trip: save at 300, play 120 -> load, replay 120: identical hash and state buffer (several seeds)', () => {
  const total = { hits: 0, windowHits: 0, bumps: 0 };
  const add = (r) => {
    total.hits += r.hits;
    total.windowHits += r.windowHits;
    total.bumps += r.bumps;
  };
  for (const seed of [7, 11, 23, 42, 99]) add(roundTrip(sim, { seed, inputSeed: seed * 3 + 1 }));
  console.log(`round trip 1v1 random inputs (5 seeds): ok, ball hits=${total.hits} bumps=${total.bumps}`);
  // Contact-heavy: every car chases the ball (car-ball, car-car and car-wall contacts, so Bullet's
  // manifold caches hold history at the save point), several save points per seed.
  // saveAt 30: the first car-ball contacts (cars start 700 uu from the ball at full throttle) land
  // INSIDE the replay window, so the window also covers fresh manifolds / hit impulses.
  for (const seed of [1, 2, 3]) {
    for (const saveAt of [30, 120, 300, 450]) add(roundTrip(sim, { seed, inputSeed: seed + 100, saveAt, contactHeavy: true }));
  }
  // 3v3: early save (contacts in the window) and a long window after 5 s of play.
  add(roundTrip(sim, { perTeam: 3, seed: 5, inputSeed: 500, saveAt: 30, replay: 150, contactHeavy: true }));
  const r6 = roundTrip(sim, { perTeam: 3, seed: 5, inputSeed: 500, saveAt: 600, replay: 300, contactHeavy: true });
  add(r6);
  console.log(`round trip contact-heavy 1v1 x9 + 3v3: ok, ball hits=${total.hits} (${total.windowHits} inside the replay windows) bumps=${total.bumps}, 3v3 blob ${r6.len} bytes`);
  assert.ok(total.windowHits > 0 && total.bumps > 0, 'the scenarios include ball touches and bumps in the replay windows');
});

test('a2. pending controls travel with the blob (set, save, step vs load, step)', () => {
  const ids = setupArena(sim, 1, 3);
  const frames = genFrames(60, 2, 9);
  runFrames(sim, frames, 0, 60, 2);
  const packed = new Int8Array(12);
  T.packControls({ throttle: 1, steer: -0.5, pitch: 0.25, yaw: 0, roll: 0, jump: true, boost: true, handbrake: false }, packed, 0);
  T.packControls({ throttle: -1, steer: 1, pitch: 0, yaw: 0.5, roll: -0.5, jump: false, boost: false, handbrake: true }, packed, 6);
  sim.setControlsPacked(packed, 2); // pending, not stepped yet
  const blob = new Uint8Array(MAX_STATE_BYTES);
  const len = sim.saveState(blob);
  sim.step(1);
  sim.sync();
  const hashA = sim.stateHash();
  // Disturb the pending controls, load, step WITHOUT setting controls: the saved ones must apply.
  sim.setControls(ids[0], T.emptyControls());
  sim.setControls(ids[1], T.emptyControls());
  sim.loadState(blob, len);
  sim.step(1);
  sim.sync();
  assert.equal(sim.stateHash(), hashA);
});

test('b. errors: different roster -> 3, truncated -> 4, bad magic / version -> 2, no arena -> 1; a failed load changes nothing', () => {
  setupArena(sim, 1, 1);
  runFrames(sim, genFrames(50, 2, 4), 0, 50, 2);
  const blob = new Uint8Array(MAX_STATE_BYTES);
  const len = sim.saveState(blob);
  const hash = sim.stateHash();

  // A fresh arena with the same roster (same creation order: ids restart at 1 per arena) loads it.
  sim.createArena();
  sim.addCar(T.Team.Blue, 0);
  sim.addCar(T.Team.Red, 3);
  sim.loadState(blob, len);
  assert.equal(sim.stateHash(), hash, 'host -> fresh client arena with the same roster');
  assert.equal(sim.tickCount, 50);

  // Truncated / corrupt -> 4, and the arena is untouched.
  for (const bad of [len - 1, len - 100, 13, 12, 4, 3, 0]) {
    assert.throws(() => sim.loadState(blob, bad), /code 4/, `len ${bad} -> code 4`);
    assert.equal(sim.stateHash(), hash, `len ${bad}: arena untouched`);
  }
  assert.throws(() => sim.loadState(blob.subarray(0, len - 7)), /code 4/, 'short view -> code 4');
  const corrupt = blob.slice(0, len);
  corrupt[12] = 7; // numCars
  assert.throws(() => sim.loadState(corrupt, len), /code 3/);
  corrupt[12] = 2;
  corrupt[20] = 0xff; // inside the first car's record: a group count no longer matches -> corrupt
  assert.throws(() => sim.loadState(corrupt, len), /code [34]/);
  assert.equal(sim.stateHash(), hash);
  // Bad magic / version -> 2.
  const magic = blob.slice(0, len);
  magic[0] = 'X'.charCodeAt(0);
  assert.throws(() => sim.loadState(magic, len), /code 2/);
  const version = blob.slice(0, len);
  version[4] = 99;
  assert.throws(() => sim.loadState(version, len), /code 2/);
  assert.equal(sim.stateHash(), hash);
  // Length arguments outside the blob.
  assert.throws(() => sim.loadState(blob, MAX_STATE_BYTES + 1), /bad length/);

  // Different rosters -> 3.
  sim.createArena();
  sim.addCar(T.Team.Red);
  sim.addCar(T.Team.Blue);
  assert.throws(() => sim.loadState(blob, len), /code 3/, 'teams swapped');
  sim.createArena();
  sim.addCar(T.Team.Blue);
  assert.throws(() => sim.loadState(blob, len), /code 3/, 'one car');
  sim.createArena();
  sim.addCar(T.Team.Blue);
  sim.addCar(T.Team.Red);
  sim.addCar(T.Team.Red);
  assert.throws(() => sim.loadState(blob, len), /code 3/, 'three cars');
  sim.createArena();
  const a = sim.addCar(T.Team.Blue);
  sim.addCar(T.Team.Red);
  sim.removeCar(a);
  sim.addCar(T.Team.Blue); // ids (2, 3): same teams per slot, different ids
  assert.throws(() => sim.loadState(blob, len), /code 3/, 'same teams, other ids');

  // No arena -> 1; saveState / stateHash without an arena.
  sim.destroyArena();
  assert.throws(() => sim.loadState(blob, len), /code 1/);
  assert.throws(() => sim.saveState(blob), /no arena/);
  assert.equal(sim.stateHash(), 0);
  sim.createArena();
});

test('c. hash: identical states hash equal, different states differ', () => {
  setupArena(sim, 1, 5);
  const h0 = sim.stateHash();
  assert.equal(sim.stateHash(), h0, 'hashing is pure');
  setupArena(sim, 1, 5);
  assert.equal(sim.stateHash(), h0, 'same seeded kickoff, same hash');
  setupArena(sim, 1, 6);
  const h1 = sim.stateHash();
  assert.notEqual(h1, h0, 'another kickoff seed');
  sim.step(1);
  assert.notEqual(sim.stateHash(), h1, 'one tick later');
  const blob = new Uint8Array(MAX_STATE_BYTES);
  const len = sim.saveState(blob);
  const h2 = sim.stateHash();
  assert.equal(h2, fnv1a32(blob, len));
  sim.setCarBoost(sim.carIdOf(0), 12.5);
  assert.notEqual(sim.stateHash(), h2, 'boost amount is part of the state');
  sim.loadState(blob, len);
  assert.equal(sim.stateHash(), h2);
  assert.ok(h0 > 0 && h0 <= 0xffffffff && Number.isInteger(h0), 'unsigned 32-bit');
});

test('d. packed controls == float controls (setControlsPacked vs setControls with v / 127)', () => {
  const frames = genFrames(240, 2, 77, 7);
  // Exhaustive-ish values too: every int8 appears on some axis.
  for (let t = 0; t < 240; t++) {
    const f = new Int8Array(frames[t]);
    f[0] = ((t * 37) % 256) - 128;
    f[7] = ((t * 53) % 256) - 128;
    f[8] = ((t * 11) % 256) - 128;
    frames[t] = f;
  }
  const ids = setupArena(sim, 1, 8);
  runFrames(sim, frames, 0, 240, 2);
  const hashPacked = sim.stateHash();
  setupArena(sim, 1, 8);
  const c = T.emptyControls();
  for (let t = 0; t < 240; t++) {
    for (let i = 0; i < 2; i++) {
      T.unpackControls(frames[t], i * PACKED_INPUT_BYTES, c);
      sim.setControls(ids[i], c);
    }
    sim.step(1);
  }
  sim.sync();
  assert.equal(sim.stateHash(), hashPacked);
  // Fewer slots than cars: the others keep their controls; more slots than the packed array throws.
  sim.setControlsPacked(frames[0], 1);
  assert.throws(() => sim.setControlsPacked(new Int8Array(6), 2), /do not fit/);
});

test('e. determinism: two independent instances, 3v3, identical inputs for 1200 ticks, equal hashes every 30 ticks; cross-instance load', async () => {
  const A = await makeSim();
  const B = await makeSim();
  const idsA = setupArena(A, 3, 4, { contactHeavy: true });
  const idsB = setupArena(B, 3, 4, { contactHeavy: true });
  assert.deepEqual(idsA, idsB);
  const frames = genFrames(1200, 6, 2024, 10);
  const blob = new Uint8Array(MAX_STATE_BYTES);
  let len = 0;
  let checks = 0;
  for (let t = 0; t < 1200; t++) {
    A.setControlsPacked(frames[t], 6);
    B.setControlsPacked(frames[t], 6);
    A.step(1);
    B.step(1);
    if ((t + 1) % 30 === 0) {
      assert.equal(A.stateHash(), B.stateHash(), `tick ${t + 1}`);
      checks++;
    }
    if (t + 1 === 600) len = A.saveState(blob);
  }
  A.sync();
  B.sync();
  assert.equal(checks, 40);
  assertBuffersIdentical(new Float32Array(A.buf), new Float32Array(B.buf), 'final state');
  // Host -> client: a blob saved on A at tick 600 loads on B, and B's replay matches A.
  const hashA1200 = A.stateHash();
  B.loadState(blob, len);
  assert.equal(B.tickCount, 600);
  assert.equal(B.stateHash(), fnv1a32(blob, len));
  runFrames(B, frames, 600, 1200, 6);
  assert.equal(B.stateHash(), hashA1200, 'cross-instance load + replay == the other instance');
  console.log('determinism 3v3: 40 hash checks over 1200 ticks equal, cross-instance load + 600-tick replay equal');
});

test('f. load({ wasmModule }): precompiled module through instantiateWasm (the workerd path); load({ wasmBinary })', async () => {
  const bytes = fs.readFileSync(WASM_PATH);
  const module = await WebAssembly.compile(bytes);
  const M = await makeSim({ wasmModule: module });
  assert.equal(M.version, '2.2.1');
  const r = roundTrip(M, { seed: 7, inputSeed: 22 });
  const rc = roundTrip(M, { seed: 2, inputSeed: 102, contactHeavy: true });
  console.log(`wasmModule path: round trips ok (blob ${r.len} bytes, ${r.hits + rc.hits} ball hits in the windows)`);
  // The same inputs give the same hash as the default-loaded instance (same wasm, same math).
  const idsM = setupArena(M, 1, 7);
  const ids = setupArena(sim, 1, 7);
  assert.deepEqual(idsM, ids);
  const frames = genFrames(200, 2, 31);
  runFrames(M, frames, 0, 200, 2);
  runFrames(sim, frames, 0, 200, 2);
  assert.equal(M.stateHash(), sim.stateHash());

  const binary = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const Bn = await makeSim({ wasmBinary: binary });
  setupArena(Bn, 1, 7);
  runFrames(Bn, frames, 0, 200, 2);
  assert.equal(Bn.stateHash(), sim.stateHash());
});

test('g. performance: save + load of a 6-car state < 50 us average; blob sizes and hash cost', () => {
  const sizes = {};
  for (const perTeam of [1, 2, 3, 4]) {
    setupArena(sim, perTeam, 2, { contactHeavy: true });
    runFrames(sim, genFrames(240, perTeam * 2, 55), 0, 240, perTeam * 2);
    const blob = new Uint8Array(MAX_STATE_BYTES);
    sizes[perTeam * 2] = sim.saveState(blob);
  }
  const max8 = sim.stateSizeMax(); // bound for the current (8-car) roster
  console.log(`blob sizes: 2 cars ${sizes[2]} B, 4 cars ${sizes[4]} B, 6 cars ${sizes[6]} B, 8 cars ${sizes[8]} B (stateSizeMax for 8 cars ${max8}, MAX_STATE_BYTES ${MAX_STATE_BYTES})`);
  assert.ok(sizes[8] <= max8, 'the 8-car bound covers an 8-car blob');
  setupArena(sim, 3, 2);
  assert.ok(sim.stateSizeMax() <= MAX_STATE_BYTES, `3v3 bound ${sim.stateSizeMax()} fits MAX_STATE_BYTES`);
  assert.ok(sizes[6] <= sim.stateSizeMax());

  setupArena(sim, 3, 9, { contactHeavy: true });
  runFrames(sim, genFrames(300, 6, 66), 0, 300, 6);
  const blob = new Uint8Array(MAX_STATE_BYTES);
  const len = sim.saveState(blob);
  const h = sim.stateHash();
  const N = 3000;
  for (let i = 0; i < 200; i++) {
    sim.saveState(blob);
    sim.loadState(blob, len);
  }
  let t0 = performance.now();
  for (let i = 0; i < N; i++) {
    sim.saveState(blob);
    sim.loadState(blob, len);
  }
  const usSaveLoad = ((performance.now() - t0) * 1000) / N;
  t0 = performance.now();
  for (let i = 0; i < N; i++) sim.stateHash();
  const usHash = ((performance.now() - t0) * 1000) / N;
  t0 = performance.now();
  for (let i = 0; i < N; i++) sim.saveState(blob);
  const usSave = ((performance.now() - t0) * 1000) / N;
  const small = new Uint8Array(len);
  t0 = performance.now();
  for (let i = 0; i < N; i++) sim.saveState(small);
  const usSaveExact = ((performance.now() - t0) * 1000) / N;
  assert.equal(sim.stateHash(), h, 'state unchanged by the save / load loop');
  const packed = genFrames(1, 6, 1)[0];
  t0 = performance.now();
  for (let i = 0; i < N; i++) sim.setControlsPacked(packed, 6);
  const usPacked = ((performance.now() - t0) * 1000) / N;
  console.log(
    `perf 6 cars (${len} B): save+load ${usSaveLoad.toFixed(1)} us, save ${usSave.toFixed(1)} us (exact-size out ${usSaveExact.toFixed(1)} us), hash ${usHash.toFixed(1)} us, setControlsPacked ${usPacked.toFixed(2)} us`,
  );
  assert.ok(usSaveLoad < 50, `save+load too slow: ${usSaveLoad} us`);
});
