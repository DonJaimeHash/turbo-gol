// Save / load of the confirmed-timeline objects the P2P rollback checkpoints carry (src/net/p2p/
// P2PSession.ts): Match.saveState / loadState, Bot + TeamContext, BotTeam. A team driven for N ticks
// on the real wasm, saved at tick k and restored after N, must reproduce the exact same controls
// from k on (RNG, filters, timers, roles included); a bot allocated after the save is discarded.
//   node --test tests/p2p-checkpoint.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

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
const T = await import('../src/sim/types.ts');
const { Bot, TeamContext } = await import('../src/ai/Bot.ts');
const { BotTeam } = await import('../src/ai/Team.ts');
const { Match } = await import('../src/game/Match.ts');
const { Rng } = await import('../src/ai/math.ts');

const mesh = buildArenaMesh().physics;

function controlsKey(c) {
  return [c.throttle, c.steer, c.pitch, c.yaw, c.roll, c.jump ? 1 : 0, c.boost ? 1 : 0, c.handbrake ? 1 : 0].map((v) => Number(v).toFixed(6)).join(',');
}

test('Match: saveState / loadState round trip every phase and the clocks; the counts are STATE_FLOATS', () => {
  const m = new Match({ lengthSeconds: 10, kickoffCountdownSeconds: 1, goalPauseSeconds: 1 });
  m.start();
  const buf = new Float64Array(Match.STATE_FLOATS + 2);
  const snapshots = [];
  for (let t = 0; t < 2400; t++) {
    const evs = m.tick(T.TICK_DT);
    if (t === 130) assert.ok(m.onGoal(1), 'goal in play');
    if (t % 97 === 0) {
      const end = m.saveState(buf, 1);
      assert.equal(end, 1 + Match.STATE_FLOATS);
      snapshots.push({ t, floats: Float64Array.from(buf), phase: m.phase, clock: m.clock, blue: m.score.blue, red: m.score.red, display: m.displaySeconds, elapsed: m.elapsed, ot: m.overtime });
    }
    void evs;
  }
  assert.equal(m.phase, 'ended', 'red leads at 0:00');
  for (const s of snapshots) {
    const n = new Match({ lengthSeconds: 10, kickoffCountdownSeconds: 1, goalPauseSeconds: 1 });
    assert.equal(n.loadState(s.floats, 1), 1 + Match.STATE_FLOATS);
    assert.equal(n.phase, s.phase, `phase at ${s.t}`);
    assert.equal(n.clock, s.clock);
    assert.deepEqual(n.score, { blue: s.blue, red: s.red });
    assert.equal(n.displaySeconds, s.display);
    assert.equal(n.elapsed, s.elapsed);
    assert.equal(n.overtime, s.ot);
    assert.equal(n.winner, s.phase === 'ended' ? 1 : null);
  }
  // A restored match continues identically: same events from the restore point on.
  const a = new Match({ lengthSeconds: 10, kickoffCountdownSeconds: 1, goalPauseSeconds: 1 });
  a.start();
  const evA = [];
  for (let t = 0; t < 300; t++) {
    if (t === 130) a.onGoal(1);
    for (const e of a.tick(T.TICK_DT)) if (t >= 200) evA.push(e.type);
    if (t === 199) a.saveState(buf, 0);
  }
  const b = new Match({ lengthSeconds: 10, kickoffCountdownSeconds: 1, goalPauseSeconds: 1 });
  b.loadState(buf, 0);
  const evB = [];
  for (let t = 200; t < 300; t++) for (const e of b.tick(T.TICK_DT)) evB.push(e.type);
  assert.deepEqual(evB, evA);
  assert.ok(evA.includes('kickoffReset'), 'the restored window covers the kickoff after the goal');
});

test('Rng: state round trip reproduces the stream', () => {
  const r = new Rng(99);
  for (let i = 0; i < 10; i++) r.next();
  const s = r.state;
  const a = [r.next(), r.next(), r.range(0, 5), r.chance(0.5)];
  const q = new Rng(1);
  q.state = s;
  assert.deepEqual([q.next(), q.next(), q.range(0, 5), q.chance(0.5)], a);
});

test('Bot / TeamContext: STATE_FLOATS matches what saveState writes; a restored bot drives exactly like the original', async () => {
  const sim = await RocketSim.load();
  sim.initArena(mesh);
  sim.createArena(T.TICK_RATE);
  sim.addCar(T.Team.Blue, T.CarPreset.Standard);
  sim.addCar(T.Team.Red, T.CarPreset.Standard);
  sim.resetKickoff(3);
  sim.sync();
  const ctx = new TeamContext();
  const cbuf = new Float64Array(TeamContext.STATE_FLOATS);
  assert.equal(ctx.saveState(cbuf, 0), TeamContext.STATE_FLOATS);
  const bot = new Bot({ team: T.Team.Red, difficulty: 'medium', seed: 11 });
  const out = T.emptyControls();
  const packed = new Int8Array(2 * T.PACKED_INPUT_BYTES);
  const buf = new Float64Array(Bot.STATE_FLOATS);
  const keys = [];
  const SAVE_AT = 500;
  for (let t = 0; t < 1200; t++) {
    sim.updateBallPrediction();
    bot.think(sim, 1, 0, out);
    if (t === SAVE_AT) assert.equal(bot.saveState(buf, 0), Bot.STATE_FLOATS, 'STATE_FLOATS floats written');
    if (t > SAVE_AT) keys.push(controlsKey(out));
    T.packControls(out, packed, T.PACKED_INPUT_BYTES);
    sim.setControlsPacked(packed, 2);
    sim.step(1);
    sim.sync();
  }
  // Replay: a fresh sim driven to SAVE_AT by the same bot (deterministic), then a DIFFERENT bot
  // object restored from the snapshot takes over and must produce the same controls.
  const sim2 = await RocketSim.load();
  sim2.initArena(mesh);
  sim2.createArena(T.TICK_RATE);
  sim2.addCar(T.Team.Blue, T.CarPreset.Standard);
  sim2.addCar(T.Team.Red, T.CarPreset.Standard);
  sim2.resetKickoff(3);
  sim2.sync();
  const bot1 = new Bot({ team: T.Team.Red, difficulty: 'medium', seed: 11 });
  const bot2 = new Bot({ team: T.Team.Red, difficulty: 'medium', seed: 12345 });
  const keys2 = [];
  for (let t = 0; t < 1200; t++) {
    sim2.updateBallPrediction();
    const driver = t <= SAVE_AT ? bot1 : bot2;
    driver.think(sim2, 1, 0, out);
    if (t === SAVE_AT) assert.equal(bot2.loadState(buf, 0), Bot.STATE_FLOATS);
    if (t > SAVE_AT) keys2.push(controlsKey(out));
    T.packControls(out, packed, T.PACKED_INPUT_BYTES);
    sim2.setControlsPacked(packed, 2);
    sim2.step(1);
    sim2.sync();
  }
  assert.deepEqual(keys2, keys, 'identical controls after the restore');
  assert.ok(new Set(keys).size > 20, 'the controls varied (not a trivial constant output)');
});

test('BotTeam: a team of two restored at tick k reproduces its controls; a bot allocated after the save is discarded', async () => {
  const teams = [T.Team.Blue, T.Team.Blue, T.Team.Red, T.Team.Red, T.Team.Red];
  const make = async () => {
    const sim = await RocketSim.load();
    sim.initArena(mesh);
    sim.createArena(T.TICK_RATE);
    for (const team of teams) sim.addCar(team, T.CarPreset.Standard);
    sim.resetKickoff(5);
    sim.sync();
    return sim;
  };
  const simA = await make();
  const simB = await make();
  const teamA = new BotTeam({ team: T.Team.Red, difficulty: 'medium', seed: 21 });
  const teamB = new BotTeam({ team: T.Team.Red, difficulty: 'medium', seed: 21 });
  const outsA = [T.emptyControls(), T.emptyControls(), T.emptyControls()];
  const outsB = [T.emptyControls(), T.emptyControls(), T.emptyControls()];
  teamA.setSlots([2, 3], [4]);
  teamB.setSlots([2, 3], [4]);
  const packed = new Int8Array(5 * T.PACKED_INPUT_BYTES);
  const buf = new Float64Array(BotTeam.stateFloatsMax());
  const SAVE_AT = 400;
  const GROW_AT = 700;
  let saved = 0;
  const keysA = [];
  // The ball prediction is forced (full re-prediction) at SAVE_AT on every run: the tracker's
  // incremental data depends on its history, a restored sim must not inherit a different one.
  const run = (sim, team, outs, keys, onTick) => {
    for (let t = 0; t < 1000; t++) {
      if (t === SAVE_AT) sim.forceBallPrediction();
      else sim.updateBallPrediction();
      onTick(t);
      team.think(sim, outs);
      if (t > SAVE_AT) keys.push(outs.slice(0, team.size).map(controlsKey).join('|'));
      packed.fill(0);
      for (let i = 0; i < team.size; i++) T.packControls(outs[i], packed, team.slotAt(i) * T.PACKED_INPUT_BYTES);
      sim.setControlsPacked(packed, 5);
      sim.step(1);
      sim.sync();
    }
  };
  run(simA, teamA, outsA, keysA, (t) => {
    if (t === SAVE_AT) {
      saved = teamA.saveState(buf, 0);
      assert.ok(saved > BotTeam.HEADER_FLOATS + 2 * Bot.STATE_FLOATS - 1 && saved <= buf.length, `saved ${saved} floats`);
    }
    if (t === GROW_AT) teamA.setSlots([2, 3, 4]); // the passive human drops: a third bot joins
  });
  // B: same run, but at SAVE_AT + 200 the team is thrown away and rebuilt from the snapshot, then
  // replayed from SAVE_AT on a sim restored to the same tick (the wasm blob of A at SAVE_AT).
  const blob = new Uint8Array(T.MAX_STATE_BYTES);
  let blobLen = 0;
  const simC = await make();
  const keysB = [];
  const teamC = new BotTeam({ team: T.Team.Red, difficulty: 'medium', seed: 21 });
  teamC.setSlots([2, 3, 4]); // three bots allocated (a layout from the "future"): loadState must shrink it
  assert.equal(teamC.size, 3);
  run(simB, teamB, outsB, [], (t) => {
    if (t === SAVE_AT) blobLen = simB.saveState(blob);
  });
  simC.loadState(blob, blobLen);
  assert.equal(simC.tickCount, SAVE_AT);
  assert.equal(teamC.loadState(buf, 0), saved);
  assert.equal(teamC.size, 2, 'back to the saved layout');
  assert.equal(teamC.passiveCount, 1);
  // Both snapshots were taken before tick SAVE_AT's think: the replay includes it (keys from SAVE_AT + 1 on, like A).
  for (let t = SAVE_AT; t < 1000; t++) {
    if (t === SAVE_AT) simC.forceBallPrediction();
    else simC.updateBallPrediction();
    const outs = outsB;
    if (t === GROW_AT) teamC.setSlots([2, 3, 4]);
    teamC.think(simC, outs);
    if (t > SAVE_AT) keysB.push(outs.slice(0, teamC.size).map(controlsKey).join('|'));
    packed.fill(0);
    for (let i = 0; i < teamC.size; i++) T.packControls(outs[i], packed, teamC.slotAt(i) * T.PACKED_INPUT_BYTES);
    simC.setControlsPacked(packed, 5);
    simC.step(1);
    simC.sync();
  }
  assert.equal(keysB.length, keysA.length);
  const firstDiff = keysB.findIndex((k, i) => k !== keysA[i]);
  if (firstDiff >= 0) console.log(`first difference at tick ${SAVE_AT + 1 + firstDiff}:
 A ${keysA[firstDiff]}
 C ${keysB[firstDiff]}`);
  assert.deepEqual(keysB, keysA, 'identical controls after the restore, through the layout change');
  assert.equal(simC.stateHash(), simA.stateHash(), 'identical sim state at the end');
});
