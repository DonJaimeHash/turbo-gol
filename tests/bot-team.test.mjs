// Self-check for src/ai/Team.ts (BotTeam: roles, kickoff duties, hysteresis, lane / yield rules).
// Runs on node (>= 23.6, type stripping) without the wasm:
//   node --test tests/bot-team.test.mjs
// Fake SimStateViews are Float32Array buffers laid out per src/sim/types.ts (see tests/bot.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z]+$/i.test(specifier) && context.parentURL) {
      const candidate = new URL(specifier + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});

const types = await import(new URL('../src/sim/types.ts', import.meta.url).href);
const botMod = await import(new URL('../src/ai/Bot.ts', import.meta.url).href);
const teamMod = await import(new URL('../src/ai/Team.ts', import.meta.url).href);
const m = await import(new URL('../src/ai/math.ts', import.meta.url).href);
const { KICKOFF_SPAWNS, ARENA } = await import(new URL('../src/sim/constants.ts', import.meta.url).href);

const { Bot, TUNING } = botMod;
const { BotTeam, TEAM_TUNING } = teamMod;
const {
  STATE_BUFFER_FLOATS, BALL_PRED_TICKS, BALL_PRED_STRIDE, BALL_OFFSET, B_POS, B_VEL, CARS_OFFSET, CAR_STRIDE,
  C_ID, C_TEAM, C_POS, C_ROT, C_VEL, C_ANG_VEL, C_BOOST, C_IS_ON_GROUND, C_IS_FLIPPING, C_IS_DEMOED, C_BALL_HIT_TICK, PADS_OFFSET,
  PAD_STRIDE, P_IS_ACTIVE, NUM_BOOST_PADS, H_NUM_CARS, TICK_DT, Team, emptyControls,
} = types;

function makeState(numCars = 4) {
  const buf = new Float32Array(STATE_BUFFER_FLOATS);
  const ballPred = new Float32Array(BALL_PRED_TICKS * BALL_PRED_STRIDE);
  buf[H_NUM_CARS] = numCars;
  for (let i = 0; i < NUM_BOOST_PADS; i++) buf[PADS_OFFSET + i * PAD_STRIDE + P_IS_ACTIVE] = 1;
  return {
    buf,
    ballPred,
    get tickCount() { return buf[0]; },
    get numCars() { return buf[H_NUM_CARS]; },
    carOffset: (slot) => CARS_OFFSET + slot * CAR_STRIDE,
    slotOf(id) { for (let s = 0; s < this.numCars; s++) if (buf[this.carOffset(s) + C_ID] === id) return s; return -1; },
  };
}

function setBall(state, x, y, z = 93.15, vx = 0, vy = 0, vz = 0) {
  const b = state.buf;
  b[BALL_OFFSET + B_POS] = x; b[BALL_OFFSET + B_POS + 1] = y; b[BALL_OFFSET + B_POS + 2] = z;
  b[BALL_OFFSET + B_VEL] = vx; b[BALL_OFFSET + B_VEL + 1] = vy; b[BALL_OFFSET + B_VEL + 2] = vz;
  for (let i = 0; i < BALL_PRED_TICKS; i++) {
    const t = (i + 1) * TICK_DT;
    const o = i * BALL_PRED_STRIDE;
    state.ballPred[o] = x + vx * t; state.ballPred[o + 1] = y + vy * t; state.ballPred[o + 2] = z + vz * t;
    state.ballPred[o + 3] = vx; state.ballPred[o + 4] = vy; state.ballPred[o + 5] = vz;
  }
}

function setCar(state, slot, { id = slot + 1, team = Team.Blue, x = 0, y = 0, z = 17, yaw = Math.PI / 2, vx = 0, vy = 0, vz = 0, boost = 100, onGround = 1, demoed = 0, fwd, right, up } = {}) {
  const b = state.buf;
  const o = state.carOffset(slot);
  b[o + C_ID] = id; b[o + C_TEAM] = team;
  b[o + C_POS] = x; b[o + C_POS + 1] = y; b[o + C_POS + 2] = z;
  const f = fwd ?? [Math.cos(yaw), Math.sin(yaw), 0];
  const r = right ?? [-Math.sin(yaw), Math.cos(yaw), 0];
  const u = up ?? [0, 0, 1];
  for (let i = 0; i < 3; i++) { b[o + C_ROT + i] = f[i]; b[o + C_ROT + 3 + i] = r[i]; b[o + C_ROT + 6 + i] = u[i]; }
  b[o + C_VEL] = vx; b[o + C_VEL + 1] = vy; b[o + C_VEL + 2] = vz;
  b[o + C_ANG_VEL] = 0; b[o + C_ANG_VEL + 1] = 0; b[o + C_ANG_VEL + 2] = 0;
  b[o + C_BOOST] = boost;
  b[o + C_IS_ON_GROUND] = onGround;
  b[o + C_IS_FLIPPING] = 0;
  b[o + C_IS_DEMOED] = demoed;
  return o;
}

/** Three red cars parked deep in their half (not a factor for blue's decisions). */
function parkOpponents(state, firstSlot, count, team = Team.Red) {
  const sgn = team === Team.Red ? 1 : -1;
  for (let i = 0; i < count; i++) setCar(state, firstSlot + i, { team, x: (i - 1) * 3000, y: sgn * 4900, yaw: team === Team.Red ? -Math.PI / 2 : Math.PI / 2 });
}

function assertFiniteControls(c, label) {
  for (const k of ['throttle', 'steer', 'pitch', 'yaw', 'roll']) {
    assert.ok(Number.isFinite(c[k]), `${label}: ${k} is ${c[k]}`);
    assert.ok(c[k] >= -1 && c[k] <= 1, `${label}: ${k} out of range ${c[k]}`);
  }
  for (const k of ['jump', 'boost', 'handbrake']) assert.equal(typeof c[k], 'boolean', `${label}: ${k} not boolean`);
}

function outsFor(n) {
  const outs = [];
  for (let i = 0; i < n; i++) outs.push(emptyControls());
  return outs;
}

/** Unsigned distance of point p from the infinite line a -> b, plus the projection along it. */
function laneOffset(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  const tx = p[0] - a[0];
  const ty = p[1] - a[1];
  return { along: tx * ux + ty * uy, lateral: Math.abs(-tx * uy + ty * ux), len };
}

test('roles: closest to the ball attacks, next supports, last defends (3v3), independent of slot order', () => {
  for (const slots of [[0, 1, 2], [2, 0, 1]]) {
    const state = makeState(6);
    setBall(state, 0, 500);
    setCar(state, 0, { team: Team.Blue, x: 0, y: -1000 });
    setCar(state, 1, { team: Team.Blue, x: 0, y: -2500 });
    setCar(state, 2, { team: Team.Blue, x: 0, y: -4000 });
    parkOpponents(state, 3, 3);
    const team = new BotTeam({ team: Team.Blue, difficulty: 'hard', seed: 1 });
    team.setSlots(slots);
    assert.equal(team.size, 3);
    const outs = outsFor(3);
    for (let k = 0; k < 12; k++) team.think(state, outs);
    const roleOfSlot = (s) => team.roleAt(slots.indexOf(s));
    assert.equal(roleOfSlot(0), 'attacker');
    assert.equal(roleOfSlot(1), 'support');
    assert.equal(roleOfSlot(2), 'defender');
    assert.equal(team.slotAt(team.attackerIndex), 0);
    assert.equal(team.botAt(slots.indexOf(0)).mode, 'attack');
    assert.equal(team.botAt(slots.indexOf(1)).mode, 'support');
    assert.equal(team.botAt(slots.indexOf(2)).mode, 'defend');
    for (let i = 0; i < 3; i++) assertFiniteControls(outs[i], `slots ${slots} member ${i}`);
    assert.ok(outs[slots.indexOf(0)].throttle > 0, 'attacker drives at the ball');
    assert.ok(!team.inKickoff);
  }
});

test('hysteresis: a marginal challenger never takes the attacker role; a clear one does, but not within 30 ticks of the last switch', () => {
  const state = makeState(4);
  setBall(state, 0, 1000);
  setCar(state, 0, { team: Team.Blue, x: -300, y: -1000 });
  setCar(state, 1, { team: Team.Blue, x: 300, y: -1050 });
  parkOpponents(state, 2, 2);
  const team = new BotTeam({ team: Team.Blue, difficulty: 'hard', seed: 2 });
  team.setSlots([0, 1]);
  const outs = outsFor(2);
  team.think(state, outs);
  assert.equal(team.attackerIndex, 0);

  // member 1 is now marginally closer: no flip-flop over 200 ticks
  setCar(state, 1, { team: Team.Blue, x: 300, y: -950 });
  for (let k = 0; k < 200; k++) {
    team.think(state, outs);
    assert.equal(team.attackerIndex, 0, `tick ${k}: marginal advantage must not switch`);
  }

  // member 1 is now clearly better (and the lockout has long expired): switches at once
  setCar(state, 0, { team: Team.Blue, x: -300, y: -3500 });
  setCar(state, 1, { team: Team.Blue, x: 300, y: -200 });
  team.think(state, outs);
  assert.equal(team.attackerIndex, 1, 'clear challenger takes over');
  assert.equal(team.roleAt(0), 'support');

  // swap again right away: the switch back waits for the 30-tick lockout
  setCar(state, 0, { team: Team.Blue, x: -300, y: -200 });
  setCar(state, 1, { team: Team.Blue, x: 300, y: -3500 });
  let switchedAt = -1;
  for (let k = 0; k < 60; k++) {
    team.think(state, outs);
    if (team.attackerIndex === 0 && switchedAt < 0) switchedAt = k;
  }
  assert.ok(switchedAt >= 25 && switchedAt <= 32, `switch back after the lockout, got tick ${switchedAt}`);
});

/** Kickoff state for `teamId` from spawn indices (red mirrored), opponents mirrored in the next slots. */
function kickoffState(teamId, idxs) {
  const state = makeState(idxs.length * 2);
  setBall(state, 0, 0);
  const sgn = teamId === Team.Blue ? 1 : -1;
  const other = teamId === Team.Blue ? Team.Red : Team.Blue;
  idxs.forEach((k, i) => {
    const [sx, sy, syaw] = KICKOFF_SPAWNS[k];
    setCar(state, i, { team: teamId, x: sx * sgn, y: sy * sgn, yaw: teamId === Team.Blue ? syaw : syaw + Math.PI, boost: 33 });
    setCar(state, idxs.length + i, { team: other, x: -sx * sgn, y: -sy * sgn, yaw: teamId === Team.Blue ? syaw + Math.PI : syaw, boost: 33 });
  });
  return state;
}

test('kickoff: closest goes (ties: lower x), next cheats to midfield, back centre stays, for 2v2 and 3v3 on both teams', () => {
  const cases = [
    { team: Team.Blue, spawns: [0, 4], duties: ['go', 'stay'] },
    { team: Team.Blue, spawns: [0, 1], duties: ['go', 'cheat'] },
    { team: Team.Blue, spawns: [1, 0], duties: ['cheat', 'go'] }, // lower x goes regardless of slot order
    { team: Team.Blue, spawns: [0, 1, 4], duties: ['go', 'cheat', 'stay'] },
    { team: Team.Blue, spawns: [0, 2, 4], duties: ['go', 'cheat', 'stay'] },
    { team: Team.Blue, spawns: [4, 1, 0], duties: ['stay', 'cheat', 'go'] },
    { team: Team.Red, spawns: [0, 1, 4], duties: ['cheat', 'go', 'stay'] }, // mirrored: spawn 1 has the lower x
    { team: Team.Red, spawns: [1, 4], duties: ['go', 'stay'] },
    { team: Team.Red, spawns: [2, 3, 4], duties: ['cheat', 'go', 'stay'] }, // mirrored inside pair: x = +600 / -600 -> member 1 goes
  ];
  for (const c of cases) {
    const label = `${c.team === Team.Blue ? 'blue' : 'red'} ${JSON.stringify(c.spawns)}`;
    const state = kickoffState(c.team, c.spawns);
    const n = c.spawns.length;
    const team = new BotTeam({ team: c.team, difficulty: 'hard', seed: 5 });
    team.setSlots(c.spawns.map((_, i) => i));
    const outs = outsFor(n);
    for (let k = 0; k < 8; k++) {
      team.think(state, outs);
      assert.ok(team.inKickoff, `${label}: in kickoff`);
      for (let i = 0; i < n; i++) {
        assert.equal(team.dutyAt(i), c.duties[i], `${label}: member ${i} duty`);
        assert.equal(team.botAt(i).mode, 'kickoff', `${label}: member ${i} mode`);
        assertFiniteControls(outs[i], `${label} member ${i}`);
      }
    }
    for (let i = 0; i < n; i++) {
      const duty = c.duties[i];
      const o = outs[i];
      const bot = team.botAt(i);
      const goalDir = c.team === Team.Red ? 1 : -1;
      if (duty === 'go') {
        assert.equal(team.roleAt(i), 'attacker');
        assert.ok(o.throttle > 0.5 && o.boost, `${label}: kicker drives with boost (${o.throttle}, ${o.boost})`);
        assert.ok(Math.abs(o.steer) < 0.6, `${label}: kicker already points at the ball`);
      } else if (duty === 'stay') {
        assert.equal(team.roleAt(i), 'defender');
        assert.ok(Math.abs(o.throttle) < 0.05, `${label}: back car stays (throttle ${o.throttle})`);
        assert.ok(!o.boost, `${label}: back car does not boost`);
      } else {
        assert.equal(team.roleAt(i), 'support');
        assert.ok(o.throttle > 0.5, `${label}: cheater drives up (${o.throttle})`);
        assert.ok(bot.target[1] * goalDir > 900 && bot.target[1] * goalDir < 1700, `${label}: cheat spot on our side of midfield (y ${bot.target[1]})`);
        const kicker = c.duties.indexOf('go');
        const kx = state.buf[state.carOffset(kicker) + C_POS];
        assert.ok(Math.sign(bot.target[0]) === -Math.sign(kx), `${label}: cheat spot off the kicker's side (x ${bot.target[0]} vs kicker x ${kx})`);
      }
    }
    // the ball moves: kickoff over, normal roles; the kicker (closest) keeps the attacker role
    setBall(state, 50, 80, 93.15, 600, 900, 0);
    team.think(state, outs);
    assert.ok(!team.inKickoff, `${label}: kickoff over`);
    assert.equal(team.roleAt(c.duties.indexOf('go')), 'attacker', `${label}: kicker stays the attacker`);
    for (let i = 0; i < n; i++) assertFiniteControls(outs[i], `${label} after kickoff member ${i}`);
  }
});

test('defender: holds a spot in front of its goal while the ball is far, throttle ~0 on the spot, no boost run', () => {
  const state = makeState(6);
  setBall(state, 500, 3500);
  setCar(state, 0, { team: Team.Blue, x: 500, y: 2500 }); // attacker
  setCar(state, 1, { team: Team.Blue, x: 0, y: 500 }); // support
  const spotY = -ARENA.extentY + TUNING.defenderDepthMax; // the ball is far: the deepest goalie spot
  setCar(state, 2, { team: Team.Blue, x: 300, y: spotY }); // defender already on its spot, facing the ball
  parkOpponents(state, 3, 3);
  const team = new BotTeam({ team: Team.Blue, difficulty: 'hard', seed: 3 });
  team.setSlots([0, 1, 2]);
  const outs = outsFor(3);
  for (let k = 0; k < 12; k++) team.think(state, outs);
  assert.equal(team.roleAt(2), 'defender');
  const d = team.botAt(2);
  assert.equal(d.mode, 'defend');
  const goalLine = -ARENA.extentY;
  const depth = d.target[1] - goalLine;
  assert.ok(depth >= TUNING.defenderDepthMin - 1 && depth <= TUNING.defenderDepthMax + 1, `defender depth ${depth}`);
  assert.ok(Math.abs(d.target[0] - 500 * TUNING.defenderXFactor) < 50, `defender tracks the ball x (${d.target[0]})`);
  assert.ok(Math.abs(outs[2].throttle) < 0.05, `on the spot: throttle ${outs[2].throttle}`);
  assert.ok(!outs[2].boost);
  assertFiniteControls(outs[2], 'defender');

  // ball coming at our goal through our third with the attacker beaten -> the defender comes out (clears)
  setBall(state, 400, -2200, 93.15, 0, -1500, 0);
  setCar(state, 0, { team: Team.Blue, x: 500, y: 3500 }); // attacker left far upfield
  setCar(state, 3, { team: Team.Red, x: 400, y: -1800, yaw: -Math.PI / 2 }); // opponent on the ball
  for (let k = 0; k < 12; k++) team.think(state, outs);
  assert.equal(team.botAt(2).mode, 'defend');
  assert.ok(outs[2].throttle > 0.3, `defender comes out to clear (${outs[2].throttle})`);
  assert.ok(team.botAt(2).targetT >= 0 || team.botAt(2).target[1] > spotY, 'target is the ball intercept, not the goalie spot');
});

test('support: positions behind the ball on our side, far side of the ball, outside the attacker lane', () => {
  // case A: plain positioning
  {
    const state = makeState(4);
    setBall(state, 1000, 1000);
    setCar(state, 0, { team: Team.Blue, x: 800, y: 0 });
    setCar(state, 1, { team: Team.Blue, x: -500, y: -1500 });
    parkOpponents(state, 2, 2);
    const team = new BotTeam({ team: Team.Blue, difficulty: 'hard', seed: 4 });
    team.setSlots([0, 1]);
    const outs = outsFor(2);
    for (let k = 0; k < 12; k++) team.think(state, outs);
    assert.equal(team.roleAt(1), 'support');
    const s = team.botAt(1);
    assert.equal(s.mode, 'support');
    const t = s.target;
    assert.ok(m.dist2D(t[0], t[1], 1000, 1000) >= TUNING.supportDepthMin, `support keeps >= ${TUNING.supportDepthMin} from the ball (${m.dist2D(t[0], t[1], 1000, 1000)})`);
    assert.ok(t[1] < 1000 - TUNING.supportDepthMin + 1, `behind the ball on our side (y ${t[1]})`);
    assert.ok(t[0] < 1000, `offset toward the far side / centre (x ${t[0]})`);
    const lane = laneOffset(t, [800, 0], [1000, 1000]);
    assert.ok(lane.along < -200 || lane.along > lane.len + TUNING.laneExtend || lane.lateral >= TUNING.laneHalfWidth, 'outside the attacker lane');
    assert.ok(m.dist2D(t[0], t[1], 800, 0) > 1000, 'well away from the attacker');
    assertFiniteControls(outs[1], 'support A');
    assert.ok(outs[1].throttle > 0, 'drives to the spot');
  }
  // case B: the natural spot sits inside the attacker's lane -> pushed out sideways
  {
    const state = makeState(4);
    setBall(state, 0, 2000);
    setCar(state, 0, { team: Team.Blue, x: 1400, y: -2000 });
    setCar(state, 1, { team: Team.Blue, x: 0, y: -4500 });
    for (let i = 0; i < 2; i++) setCar(state, 2 + i, { team: Team.Red, x: i === 0 ? -3500 : 3500, y: 4900, yaw: -Math.PI / 2 });
    const team = new BotTeam({ team: Team.Blue, difficulty: 'hard', seed: 4 });
    team.setSlots([0, 1]);
    const outs = outsFor(2);
    for (let k = 0; k < 12; k++) team.think(state, outs);
    assert.equal(team.roleAt(1), 'support');
    assert.equal(team.botAt(1).mode, 'support');
    const t = team.botAt(1).target;
    const lane = laneOffset(t, [1400, -2000], [0, 2000]);
    assert.ok(lane.along >= -200 && lane.along <= lane.len + TUNING.laneExtend, `spot is alongside the lane (along ${lane.along})`);
    assert.ok(lane.lateral >= TUNING.laneHalfWidth - 1, `pushed out of the lane (lateral ${lane.lateral})`);
    assertFiniteControls(outs[1], 'support B');
  }
});

test('yield: a lower-ranked teammate within 400 uu of a higher-ranked one brakes and steers away', () => {
  const state = makeState(4);
  setBall(state, 0, 1000);
  setCar(state, 0, { team: Team.Blue, x: 0, y: -1000 });
  setCar(state, 1, { team: Team.Blue, x: 0, y: -1300 });
  parkOpponents(state, 2, 2);
  const team = new BotTeam({ team: Team.Blue, difficulty: 'hard', seed: 6 });
  team.setSlots([0, 1]);
  const outs = outsFor(2);
  for (let k = 0; k < 6; k++) team.think(state, outs);
  assert.equal(team.attackerIndex, 0);
  assert.ok(!team.botAt(0).teamCtx.yield, 'the attacker never yields');
  assert.ok(team.botAt(1).teamCtx.yield, 'the support yields');
  assert.ok(outs[1].throttle <= 0, `yielding car does not push (${outs[1].throttle})`);
  assert.equal(Math.abs(outs[1].steer), 1, 'full steer away');
  assert.ok(!outs[1].boost);
  assert.ok(outs[0].throttle > 0, 'the attacker keeps going');
  // far apart again: no yield
  setCar(state, 1, { team: Team.Blue, x: 0, y: -3000 });
  for (let k = 0; k < 6; k++) team.think(state, outs);
  assert.ok(!team.botAt(1).teamCtx.yield);
});

test('demolished attacker is replaced at once; the lockout applies to the switch back after respawn', () => {
  const state = makeState(6);
  setBall(state, 0, 500);
  setCar(state, 0, { team: Team.Blue, x: 0, y: -1000 });
  setCar(state, 1, { team: Team.Blue, x: 0, y: -2500 });
  setCar(state, 2, { team: Team.Blue, x: 0, y: -4000 });
  parkOpponents(state, 3, 3);
  const team = new BotTeam({ team: Team.Blue, difficulty: 'medium', seed: 8 });
  team.setSlots([0, 1, 2]);
  const outs = outsFor(3);
  for (let k = 0; k < 40; k++) team.think(state, outs);
  assert.equal(team.attackerIndex, 0);
  state.buf[state.carOffset(0) + C_IS_DEMOED] = 1;
  team.think(state, outs);
  assert.equal(team.attackerIndex, 1, 'next best takes over immediately');
  assert.equal(team.roleAt(1), 'attacker');
  assert.equal(team.roleAt(2), 'support');
  assert.equal(outs[0].throttle, 0, 'demoed car gets neutral controls');
  assert.ok(!outs[0].boost && !outs[0].jump);
  state.buf[state.carOffset(0) + C_IS_DEMOED] = 0;
  let back = -1;
  for (let k = 0; k < 60; k++) {
    team.think(state, outs);
    if (team.attackerIndex === 0 && back < 0) back = k;
  }
  assert.ok(back >= 25 && back <= 32, `respawned car retakes the role after the lockout (tick ${back})`);
});

test('one slot behaves exactly like a standalone Bot (same seed, same inputs, same outputs)', () => {
  for (const difficulty of ['easy', 'medium', 'hard']) {
    const rng = new m.Rng(11);
    const state = makeState(2);
    const solo = new Bot({ team: Team.Red, difficulty, seed: 3 });
    const team = new BotTeam({ team: Team.Red, difficulty, seed: 3 });
    team.setSlots([1]);
    const outSolo = emptyControls();
    const outs = [emptyControls()];
    for (let k = 0; k < 600; k++) {
      if (k % 7 === 0) {
        setBall(state, rng.range(-4000, 4000), rng.range(-5000, 5000), rng.range(93, 1500), rng.range(-2000, 2000), rng.range(-2000, 2000), rng.range(-800, 800));
        const air = rng.chance(0.25);
        setCar(state, 1, {
          team: Team.Red, x: rng.range(-4000, 4000), y: rng.range(-5000, 5000), z: air ? rng.range(100, 1200) : 17,
          yaw: rng.range(-Math.PI, Math.PI), vx: rng.range(-2300, 2300), vy: rng.range(-2300, 2300), vz: air ? rng.range(-500, 500) : 0,
          boost: rng.range(0, 100), onGround: air ? 0 : 1,
        });
        setCar(state, 0, { team: Team.Blue, x: rng.range(-4000, 4000), y: rng.range(-5000, 5000), yaw: rng.range(-Math.PI, Math.PI), vx: rng.range(-2300, 2300), vy: rng.range(-2300, 2300) });
        for (let i = 0; i < NUM_BOOST_PADS; i++) state.buf[PADS_OFFSET + i * PAD_STRIDE + P_IS_ACTIVE] = rng.chance(0.7) ? 1 : 0;
      }
      if (k % 97 === 0) setBall(state, 0, 0); // kickoffs too
      solo.think(state, 1, 0, outSolo);
      team.think(state, outs);
      assert.deepEqual(outs[0], outSolo, `${difficulty} tick ${k}: team-of-one differs from the standalone bot`);
      assert.equal(team.botAt(0).mode, solo.mode, `${difficulty} tick ${k}: mode`);
    }
    assert.equal(team.roleAt(0), 'attacker');
  }
});

test('never outputs NaN across random 2v2 / 3v3 states, demos, difficulties and degenerate buffers', () => {
  const rng = new m.Rng(21);
  for (const difficulty of ['easy', 'medium', 'hard']) {
    for (const per of [2, 3]) {
      const state = makeState(per * 2);
      const team = new BotTeam({ team: Team.Red, difficulty, seed: 9 });
      const slots = [];
      for (let i = 0; i < per; i++) slots.push(per + i);
      team.setSlots(slots);
      const outs = outsFor(per);
      for (let k = 0; k < 500; k++) {
        if (k % 5 === 0) {
          if (rng.chance(0.08)) setBall(state, 0, 0);
          else setBall(state, rng.range(-4000, 4000), rng.range(-5000, 5000), rng.range(93, 1900), rng.range(-2500, 2500), rng.range(-2500, 2500), rng.range(-1000, 1000));
          for (let s = 0; s < per * 2; s++) {
            const air = rng.chance(0.25);
            setCar(state, s, {
              team: s < per ? Team.Blue : Team.Red, x: rng.range(-4000, 4000), y: rng.range(-5000, 5000), z: air ? rng.range(100, 1500) : 17,
              yaw: rng.range(-Math.PI, Math.PI), vx: rng.range(-2300, 2300), vy: rng.range(-2300, 2300), vz: air ? rng.range(-500, 500) : 0,
              boost: rng.range(0, 100), onGround: air ? 0 : 1, demoed: rng.chance(0.15) ? 1 : 0,
            });
            if (air && rng.chance(0.5)) {
              const o = state.carOffset(s);
              for (let i = 0; i < 9; i++) state.buf[o + C_ROT + i] = rng.range(-1, 1);
              state.buf[o + C_IS_FLIPPING] = rng.chance(0.5) ? 1 : 0;
            }
          }
          for (let i = 0; i < NUM_BOOST_PADS; i++) state.buf[PADS_OFFSET + i * PAD_STRIDE + P_IS_ACTIVE] = rng.chance(0.7) ? 1 : 0;
        }
        team.think(state, outs);
        for (let i = 0; i < per; i++) assertFiniteControls(outs[i], `${difficulty} ${per}v${per} #${k} member ${i}`);
        for (let i = 0; i < per; i++) assert.ok(['attacker', 'support', 'defender'].includes(team.roleAt(i)));
      }
      // all demoed -> no attacker, still finite
      for (let s = per; s < per * 2; s++) state.buf[state.carOffset(s) + C_IS_DEMOED] = 1;
      team.think(state, outs);
      assert.equal(team.attackerIndex, -1);
      for (let i = 0; i < per; i++) assertFiniteControls(outs[i], `${difficulty} all demoed member ${i}`);
    }
    // degenerate: blank buffer with no cars, invalid slots, fewer outs than slots, empty team
    const blank = makeState(0);
    const team = new BotTeam({ team: Team.Blue, difficulty, seed: 1 });
    team.setSlots([0, 1, 9]);
    const outs = outsFor(2);
    team.think(blank, outs);
    for (let i = 0; i < 2; i++) assertFiniteControls(outs[i], `${difficulty} blank member ${i}`);
    const small = makeState(2);
    setCar(small, 0, { team: Team.Blue });
    setCar(small, 1, { team: Team.Red, y: 3000 });
    team.setSlots([0, 5]); // slot 5 does not exist
    team.think(small, outsFor(2));
    assert.equal(team.roleAt(0), 'attacker');
    team.setSlots([]);
    team.think(small, outsFor(0));
    assert.equal(team.size, 0);
  }
});

test('API: setDifficulty reaches every bot, reset clears roles, TEAM_TUNING is exposed', () => {
  const team = new BotTeam({ team: Team.Blue, difficulty: 'easy', seed: 1 });
  team.setSlots([0, 1, 2]);
  for (let i = 0; i < 3; i++) assert.equal(team.botAt(i).difficulty, 'easy');
  team.setDifficulty('hard');
  for (let i = 0; i < 3; i++) assert.equal(team.botAt(i).difficulty, 'hard');
  const state = makeState(6);
  setBall(state, 0, 500);
  for (let s = 0; s < 3; s++) setCar(state, s, { team: Team.Blue, x: 0, y: -1000 - s * 1500 });
  parkOpponents(state, 3, 3);
  team.think(state, outsFor(3));
  assert.equal(team.attackerIndex, 0);
  team.reset();
  assert.equal(team.attackerIndex, -1);
  assert.ok(TEAM_TUNING.switchMinTicks === 30 && TEAM_TUNING.yieldDist === 400);
});

test('passive human: kickoff duties count the human (diagonal human -> back-centre bot stays; back-centre human -> bot goes)', () => {
  // slot 0 = the human (passive), slot 1 = the bot
  {
    const state = kickoffState(Team.Blue, [0, 4]); // human on the closest diagonal, bot at back centre
    const team = new BotTeam({ team: Team.Blue, difficulty: 'hard', seed: 5 });
    team.setSlots([1], [0]);
    assert.equal(team.size, 1);
    assert.equal(team.passiveCount, 1);
    assert.equal(team.memberCount, 2);
    assert.ok(team.isPassive(1) && !team.isPassive(0));
    assert.equal(team.slotAt(1), 0);
    const outs = outsFor(1);
    for (let k = 0; k < 8; k++) team.think(state, outs);
    assert.ok(team.inKickoff);
    assert.equal(team.dutyAt(1), 'go', 'the human is the kicker');
    assert.equal(team.attackerIndex, 1);
    assert.equal(team.dutyAt(0), 'stay', 'the back-centre bot stays');
    assert.equal(team.roleAt(0), 'defender');
    assert.ok(Math.abs(outs[0].throttle) < 0.05 && !outs[0].boost, `bot holds (${outs[0].throttle}, ${outs[0].boost})`);
    assertFiniteControls(outs[0], 'stay bot');
  }
  {
    const state = kickoffState(Team.Blue, [4, 0]); // human at back centre, bot on the diagonal
    const team = new BotTeam({ team: Team.Blue, difficulty: 'hard', seed: 5 });
    team.setSlots([1], [0]);
    const outs = outsFor(1);
    for (let k = 0; k < 8; k++) team.think(state, outs);
    assert.equal(team.dutyAt(0), 'go', 'the diagonal bot goes');
    assert.equal(team.dutyAt(1), 'stay', 'the human would stay');
    assert.ok(outs[0].throttle > 0.5 && outs[0].boost, `bot kicks off (${outs[0].throttle}, ${outs[0].boost})`);
  }
  {
    // 3v3: human on the +x diagonal, bots on the -x diagonal (lower x: goes) and at back centre (stays)
    const state = kickoffState(Team.Blue, [1, 0, 4]);
    const team = new BotTeam({ team: Team.Blue, difficulty: 'hard', seed: 5 });
    team.setSlots([1, 2], [0]);
    const outs = outsFor(2);
    for (let k = 0; k < 8; k++) team.think(state, outs);
    assert.equal(team.dutyAt(0), 'go');
    assert.equal(team.dutyAt(1), 'stay');
    assert.equal(team.dutyAt(2), 'cheat', 'the human is expected to cheat up');
    assert.ok(outs[0].throttle > 0.5 && outs[0].boost);
    assert.ok(Math.abs(outs[1].throttle) < 0.05);
  }
});

test('passive human in play: closest human attacks -> the bot supports out of its lane and yields to it; far human -> the bot attacks', () => {
  const state = makeState(4);
  setBall(state, 0, 500);
  setCar(state, 0, { team: Team.Blue, x: 0, y: -1000 }); // human, closest
  setCar(state, 1, { team: Team.Blue, x: 0, y: -2500 }); // bot
  parkOpponents(state, 2, 2);
  const team = new BotTeam({ team: Team.Blue, difficulty: 'hard', seed: 4 });
  team.setSlots([1], [0]);
  const outs = outsFor(1);
  for (let k = 0; k < 12; k++) team.think(state, outs);
  assert.equal(team.attackerIndex, 1, 'the human holds the attacker role');
  assert.equal(team.roleAt(1), 'attacker');
  assert.equal(team.roleAt(0), 'support');
  const bot = team.botAt(0);
  assert.equal(bot.mode, 'support');
  assert.ok(bot.teamCtx.hasAttacker, 'hasAttacker with the human');
  assert.ok(Math.abs(bot.teamCtx.attackerPos[0]) < 1 && Math.abs(bot.teamCtx.attackerPos[1] + 1000) < 1, `attackerPos is the human's (${bot.teamCtx.attackerPos})`);
  assert.ok(Math.abs(bot.teamCtx.attackerBallDist - 1500) < 1);
  const lane = laneOffset(bot.target, [0, -1000], [0, 500]);
  assert.ok(lane.along < -200 || lane.along > lane.len + TUNING.laneExtend || lane.lateral >= TUNING.laneHalfWidth - 1, `support spot outside the human's lane (along ${lane.along}, lateral ${lane.lateral})`);
  assertFiniteControls(outs[0], 'support bot');
  // right next to the human: the bot yields to it
  setCar(state, 1, { team: Team.Blue, x: 0, y: -1300 });
  for (let k = 0; k < 6; k++) team.think(state, outs);
  assert.ok(bot.teamCtx.yield, 'yields to the higher-ranked human');
  assert.ok(Math.abs(bot.teamCtx.yieldPos[1] + 1000) < 1);
  assert.ok(outs[0].throttle <= 0 && Math.abs(outs[0].steer) === 1);
  // the human is far from the ball: the bot takes over after the switch lockout
  setCar(state, 0, { team: Team.Blue, x: 0, y: -4500 });
  setCar(state, 1, { team: Team.Blue, x: 0, y: -1000 });
  for (let k = 0; k < 40; k++) team.think(state, outs);
  assert.equal(team.attackerIndex, 0);
  assert.equal(team.roleAt(0), 'attacker');
  assert.equal(bot.mode, 'attack');
  assert.ok(!bot.teamCtx.hasAttacker);
  // same line-up from a fresh team (the static car above has been "pushing" for 58 ticks, so its
  // wedge detector is in its reverse phase): the bot attacks from the first tick
  const fresh = new BotTeam({ team: Team.Blue, difficulty: 'hard', seed: 4 });
  fresh.setSlots([1], [0]);
  for (let k = 0; k < 3; k++) fresh.think(state, outs);
  assert.equal(fresh.attackerIndex, 0);
  assert.equal(fresh.botAt(0).mode, 'attack');
  assert.ok(outs[0].throttle > 0, `attacks the ball (${outs[0].throttle})`);
});

test('attacker stall: 90 ticks next to a low ball without a touch hands the role over; the lockout holds until a touch', () => {
  const state = makeState(4);
  setBall(state, 300, 200);
  setCar(state, 0, { team: Team.Blue, x: 300, y: -100 }); // on the ball (within stallBallDist), never touches it
  setCar(state, 1, { team: Team.Blue, x: 0, y: -2500 });
  parkOpponents(state, 2, 2);
  const team = new BotTeam({ team: Team.Blue, difficulty: 'hard', seed: 6 });
  team.setSlots([0, 1]);
  const outs = outsFor(2);
  team.think(state, outs);
  assert.equal(team.attackerIndex, 0);
  let handedOver = -1;
  for (let k = 0; k < 200; k++) {
    team.think(state, outs);
    if (team.attackerIndex === 1 && handedOver < 0) handedOver = k;
    assertFiniteControls(outs[0], `stall ${k} #0`);
    assertFiniteControls(outs[1], `stall ${k} #1`);
  }
  assert.ok(handedOver >= TEAM_TUNING.stallTicks - 3 && handedOver <= TEAM_TUNING.stallTicks + 1, `hand-over after ~${TEAM_TUNING.stallTicks} ticks (got ${handedOver})`);
  assert.equal(team.attackerIndex, 1, 'still the new attacker 100+ ticks later (the stalled car is locked out)');
  assert.equal(team.roleAt(0), 'support');
  assert.equal(team.roleAt(1), 'attacker');
  const nb = team.botAt(1);
  assert.equal(nb.mode, 'attack', 'the new attacker goes for the ball');
  assert.ok(m.dist2D(nb.target[0], nb.target[1], 300, 200) < 600, `its target is the ball's hit point (${nb.target[0]}, ${nb.target[1]})`);
  // a touch by the stalled car clears its lockout: it retakes the role (clearly faster) after the switch lockout
  state.buf[state.carOffset(0) + C_BALL_HIT_TICK] = 9;
  let back = -1;
  for (let k = 0; k < 60; k++) {
    team.think(state, outs);
    if (team.attackerIndex === 0 && back < 0) back = k;
  }
  assert.ok(back >= 0 && back <= 35, `retakes the attacker role after touching the ball (tick ${back})`);
});
