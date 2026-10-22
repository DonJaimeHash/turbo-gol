// The golden stock trace: two seeded headless runs whose state hashes (rs_state_hash) and ball
// prediction hashes are recorded every second of game time. tests/stock-trace.test.mjs replays them
// against tests/fixtures/stock-trace.json, which was recorded with the wasm and the bots from BEFORE
// the physics mutators existed (rocketsim.wasm c137f952). A rebuilt wasm or a bot change that keeps
// stock behaviour byte-identical reproduces every hash; anything else changes the physics every
// online peer, server and community node must agree on, and then PROTOCOL_VERSION
// (src/net/protocol.ts) and P2P_PROTOCOL_VERSION (src/net/p2p/protocol.ts) have to move with it.
//
//   node scripts/stock-trace.mjs            run both scenarios, compare with the fixture
//   node scripts/stock-trace.mjs --write    re-record the fixture (only for a deliberate physics change)
//
// Scenarios:
//   bots-3v3     3v3 hard bots (BotTeam vs BotTeam, the smoke-match set-up), 2 minutes, kickoff
//                reset after every goal, ball prediction every 4 ticks (what the bots read)
//   random-2v2   2v2 seeded random inputs held for 8-60 ticks (flips, double jumps, air roll,
//                handbrake, boost), demolitions on contact (respawns), 1 minute
//
// `runStockTrace(name, opts)` takes { mutators, physics } so the tests can run the same scenarios
// through rs_set_mutators with the stock values and the bots with an explicit stock profile.
import { registerHooks } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
const { buildArenaMesh } = await import('../src/sim/arenaMesh.ts');
const { BotTeam } = await import('../src/ai/Team.ts');
const T = await import('../src/sim/types.ts');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE = join(root, 'tests', 'fixtures', 'stock-trace.json');

/** Ticks between two recorded hashes (one second of game time). */
const EVERY = 120;
const GOAL_PAUSE_TICKS = 30;

/** FNV-1a 32 over bytes, the same function rs_state_hash uses. */
function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const predBytes = (sim) => new Uint8Array(sim.ballPred.buffer, sim.ballPred.byteOffset, sim.ballPred.byteLength);

/** mulberry32, local so the trace never depends on src/ai's Rng. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    let t = (s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let shared = null;
async function sharedSim() {
  if (shared === null) {
    const sim = await RocketSim.load();
    sim.initArena(buildArenaMesh().physics);
    shared = sim;
  }
  return shared;
}

function newArena(sim, perTeam, mutators) {
  sim.createArena(T.TICK_RATE, mutators ?? null);
  sim.events.onGoal = undefined;
  sim.events.onBump = undefined;
  sim.events.onBallHit = undefined;
  for (let i = 0; i < perTeam; i++) sim.addCar(T.Team.Blue, T.CarPreset.Standard);
  for (let i = 0; i < perTeam; i++) sim.addCar(T.Team.Red, T.CarPreset.Standard);
}

function botsRun(sim, opts) {
  const ticks = opts.ticks ?? 14400;
  newArena(sim, 3, opts.mutators);
  let kickoffSeed = 0;
  sim.resetKickoff(kickoffSeed++);
  sim.sync();
  const slotBuf = new Int32Array(T.MAX_CARS);
  const blueSlots = Array.from(slotBuf.subarray(0, sim.slotsOfTeam(T.Team.Blue, slotBuf)));
  const redSlots = Array.from(slotBuf.subarray(0, sim.slotsOfTeam(T.Team.Red, slotBuf)));
  const teamOpts = opts.physics ? { physics: opts.physics } : {};
  const blue = new BotTeam({ team: T.Team.Blue, difficulty: 'hard', seed: 777, ...teamOpts });
  const red = new BotTeam({ team: T.Team.Red, difficulty: 'hard', seed: 7, ...teamOpts });
  blue.setSlots(blueSlots);
  red.setSlots(redSlots);
  const blueOuts = blueSlots.map(() => T.emptyControls());
  const redOuts = redSlots.map(() => T.emptyControls());
  let goals = 0;
  let bumps = 0;
  let demos = 0;
  sim.events.onGoal = () => goals++;
  sim.events.onBump = (_a, _b, isDemo) => {
    bumps++;
    if (isDemo) demos++;
  };
  const hashes = [];
  const predHashes = [];
  let pause = 0;
  for (let tick = 1; tick <= ticks; tick++) {
    if (pause > 0) {
      if (--pause === 0) {
        sim.resetKickoff(kickoffSeed++);
        sim.sync();
        blue.reset();
        red.reset();
      }
      sim.step(1);
      sim.sync();
    } else {
      const age = sim.tickCount - sim.predTick;
      if (age >= 4 || age < 0) sim.updateBallPrediction();
      blue.think(sim, blueOuts);
      red.think(sim, redOuts);
      for (let i = 0; i < blueSlots.length; i++) sim.setControls(sim.carIdOf(blueSlots[i]), blueOuts[i]);
      for (let i = 0; i < redSlots.length; i++) sim.setControls(sim.carIdOf(redSlots[i]), redOuts[i]);
      const before = goals;
      sim.step(1);
      sim.sync();
      if (goals > before) pause = GOAL_PAUSE_TICKS;
    }
    if (tick % EVERY === 0) {
      hashes.push(sim.stateHash());
      predHashes.push(fnv1a(predBytes(sim)));
    }
  }
  return { name: 'bots-3v3', ticks, every: EVERY, goals, bumps, demos, hashes, predHashes };
}

function randomRun(sim, opts) {
  const ticks = opts.ticks ?? 7200;
  newArena(sim, 2, opts.mutators);
  sim.setDemoMode(1);
  sim.resetKickoff(11);
  sim.sync();
  const rand = rng(20261021);
  const n = sim.numCars;
  const buf = sim.buf;
  // Per car: the held controls, how long they stay, and what it chases (-1 the ball, a slot, or
  // nothing = pure random inputs).
  const held = [];
  for (let s = 0; s < n; s++) held.push({ left: 0, chase: null, c: T.emptyControls() });
  const axis = () => {
    const r = rand();
    return r < 0.25 ? -1 : r < 0.5 ? 1 : r < 0.6 ? 0 : rand() * 2 - 1;
  };
  let goals = 0;
  let bumps = 0;
  let demos = 0;
  let supersonic = 0;
  sim.events.onGoal = () => goals++;
  sim.events.onBump = (_a, _b, isDemo) => {
    bumps++;
    if (isDemo) demos++;
  };
  const hashes = [];
  const predHashes = [];
  for (let tick = 1; tick <= ticks; tick++) {
    for (let s = 0; s < n; s++) {
      const h = held[s];
      const c = h.c;
      if (h.left <= 0) {
        h.left = 8 + Math.floor(rand() * 53);
        const r = rand();
        h.chase = r < 0.3 ? -1 : r < 0.8 ? Math.floor(rand() * n) : null;
        if (h.chase !== null) h.left += 60;
        if (h.chase === s) h.chase = -1;
        c.throttle = rand() < 0.8 ? 1 : axis();
        c.steer = axis();
        c.pitch = axis();
        c.yaw = axis();
        c.roll = rand() < 0.3 ? axis() : 0;
        c.jump = rand() < 0.15;
        c.boost = rand() < 0.5;
        c.handbrake = rand() < 0.15;
      } else if (c.jump && rand() < 0.2) {
        c.jump = false; // release so the next press can double jump / flip
      } else if (!c.jump && rand() < 0.008) {
        c.jump = true;
      }
      if (h.chase !== null) {
        // Drive at the ball or at another car on full boost (supersonic, bumps, demolitions).
        const o = T.CARS_OFFSET + s * T.CAR_STRIDE;
        const t = h.chase < 0 ? T.BALL_OFFSET + T.B_POS : T.CARS_OFFSET + h.chase * T.CAR_STRIDE + T.C_POS;
        const dx = buf[t] - buf[o + T.C_POS];
        const dy = buf[t + 1] - buf[o + T.C_POS + 1];
        const f = buf[o + T.C_ROT] * dx + buf[o + T.C_ROT + 1] * dy;
        const r = buf[o + T.C_ROT + 3] * dx + buf[o + T.C_ROT + 4] * dy;
        const a = Math.atan2(r, f);
        c.throttle = 1;
        c.steer = Math.max(-1, Math.min(1, a * 3));
        c.boost = Math.abs(a) < 0.5;
        c.handbrake = Math.abs(a) > 1.8;
        // On the roof or the side: tap jump (RocketSim's auto-flip puts the car back on its wheels).
        c.jump = buf[o + T.C_ROT + 8] < 0.5 && tick % 20 < 10;
      }
      h.left--;
      sim.setControls(sim.carIdOf(s), c);
    }
    if (tick % 8 === 0) sim.updateBallPrediction();
    sim.step(1);
    sim.sync();
    for (let s = 0; s < n; s++) if (buf[T.CARS_OFFSET + s * T.CAR_STRIDE + T.C_IS_SUPERSONIC] !== 0) supersonic++;
    if (tick % 900 === 0) {
      sim.resetKickoff(tick);
      sim.sync();
    }
    if (tick % EVERY === 0) {
      hashes.push(sim.stateHash());
      predHashes.push(fnv1a(predBytes(sim)));
    }
  }
  return { name: 'random-2v2', ticks, every: EVERY, goals, bumps, demos, supersonic, hashes, predHashes };
}

export const SCENARIOS = ['bots-3v3', 'random-2v2'];

/**
 * Run one scenario on a shared instance. opts: { mutators?: Float32Array (createArena's second
 * argument), physics?: BotPhysics (both BotTeams), ticks?: number, sim?: RocketSim }.
 */
export async function runStockTrace(name, opts = {}) {
  const sim = opts.sim ?? (await sharedSim());
  if (name === 'bots-3v3') return botsRun(sim, opts);
  if (name === 'random-2v2') return randomRun(sim, opts);
  throw new Error(`unknown scenario ${name}`);
}

export function readFixture() {
  return JSON.parse(readFileSync(FIXTURE, 'utf8'));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const write = process.argv.includes('--write');
  const { ROCKETSIM_WASM_SHA256 } = await import('../src/sim/wasm/rocketsim.sha256.ts');
  const out = { recordedWith: { wasmSha256: ROCKETSIM_WASM_SHA256, every: EVERY }, scenarios: [] };
  let ok = true;
  const fixture = write ? null : readFixture();
  for (const name of SCENARIOS) {
    const t0 = performance.now();
    const r = await runStockTrace(name);
    const ms = performance.now() - t0;
    out.scenarios.push(r);
    let verdict = '';
    if (fixture) {
      const want = fixture.scenarios.find((s) => s.name === name);
      const firstBad = want ? r.hashes.findIndex((h, i) => h !== want.hashes[i] || r.predHashes[i] !== want.predHashes[i]) : 0;
      if (!want || firstBad >= 0 || r.hashes.length !== want.hashes.length) {
        ok = false;
        verdict = `  DIFFERS from the fixture at second ${firstBad + 1}`;
      } else verdict = '  identical to the fixture';
    }
    console.log(`${name}: ${r.ticks} ticks in ${ms.toFixed(0)} ms, ${r.goals} goals, ${r.bumps} bumps (${r.demos} demos)${verdict}`);
  }
  if (write) {
    mkdirSync(dirname(FIXTURE), { recursive: true });
    writeFileSync(FIXTURE, JSON.stringify(out, null, 1) + '\n');
    console.log(`wrote ${FIXTURE}`);
  }
  if (!ok) process.exit(1);
}
