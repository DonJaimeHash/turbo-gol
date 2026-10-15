// Training shot validity against the real physics (node --test tests/training-shots.test.mjs; needs
// src/sim/wasm/rocketsim.{js,wasm}). Every shot of every pack is played through the real
// TrainingSession with hooks that place / release it exactly like Game.trainingPlaceShot /
// trainingReleaseShot, and the player gives NO input after the release:
//   - Shooting / Aerial: the attempt must end by TIMEOUT (no goal in either net, grace included):
//     the ball never scores by itself.
//   - Saving: the attempt must end CONCEDED before the time limit, without the idle car touching
//     the ball first: there is always something to save.
// Plus the static checks: pack catalogue shape, car and ball inside the arena, not touching.
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
const { buildArenaMesh, isInsideArena } = await import('../src/sim/arenaMesh.ts');
const T = await import('../src/sim/types.ts');
const K = await import('../src/sim/constants.ts');
const P = await import('../src/game/trainingPacks.ts');
const { TrainingSession } = await import('../src/game/TrainingSession.ts');

const sim = await RocketSim.load();
sim.initArena(buildArenaMesh().physics);

const ZERO = [0, 0, 0];
const { ARENA, BALL, CAR_STANDARD } = K;

// ---- catalogue -----------------------------------------------------------------------------

test('catalogue: 9 packs = 3 categories x 3 difficulties, ids, 6-8 named shots, sane numbers', () => {
  assert.equal(P.TRAINING_PACKS.length, 9);
  const ids = new Set();
  for (const c of P.TRAINING_CATEGORIES) {
    for (const d of P.TRAINING_DIFFICULTIES) {
      const id = `${c}-${d}`;
      const pack = P.packById(id);
      assert.ok(pack, id);
      assert.equal(pack.id, id);
      assert.equal(pack.category, c);
      assert.equal(pack.difficulty, d);
      assert.ok(pack.name.length > 0 && pack.description.length > 0, id);
      assert.ok(pack.timeLimitSeconds >= 5 && pack.timeLimitSeconds <= 15, `${id} time limit`);
      assert.ok(pack.shots.length >= 6 && pack.shots.length <= 8, `${id}: ${pack.shots.length} shots`);
      const names = new Set(pack.shots.map((s) => s.name));
      assert.equal(names.size, pack.shots.length, `${id}: shot names are unique`);
      ids.add(id);
    }
  }
  assert.equal(ids.size, 9);
  assert.equal(P.FREEPLAY_ID, 'freeplay');
  assert.equal(P.FREEPLAY_NAME, 'Free play');
  assert.deepEqual([...P.TRAINING_CATEGORIES], ['shooting', 'saving', 'aerial']);
  assert.deepEqual([...P.TRAINING_DIFFICULTIES], ['easy', 'medium', 'hard']);
  assert.deepEqual(P.CATEGORY_LABELS, { shooting: 'Shooting', saving: 'Saving', aerial: 'Aerials' });
  assert.deepEqual(P.DIFFICULTY_LABELS, { easy: 'Beginner', medium: 'Intermediate', hard: 'Expert' });
  assert.equal(P.packById('shooting-easy').name, 'Shooting · Beginner');
  assert.equal(P.packById('saving-hard').name, 'Saving · Expert');
  assert.equal(P.packById('aerial-medium').name, 'Aerials · Intermediate');
  // The free-play car starts on the blue keeper kickoff spot.
  const keeper = K.KICKOFF_SPAWNS[K.KICKOFF_SPAWNS.length - 1];
  assert.deepEqual([P.FREEPLAY_CAR_SPAWN.pos[0], P.FREEPLAY_CAR_SPAWN.pos[1]], [keeper[0], keeper[1]]);
  assert.equal(P.packById(P.FREEPLAY_ID), undefined, 'free play is not a pack');
  assert.equal(P.packById('nope'), undefined);
  for (const pack of P.TRAINING_PACKS) {
    for (const s of pack.shots) {
      const nums = [...s.car.pos, s.car.yaw, s.car.boost, ...(s.car.vel ?? []), ...s.ball.pos, ...s.ball.vel, ...s.ball.angVel];
      assert.ok(nums.every(Number.isFinite), `${pack.id} / ${s.name}: finite`);
      assert.ok(s.car.boost >= 0 && s.car.boost <= 100, `${pack.id} / ${s.name}: boost`);
      assert.equal(s.car.pos[2], CAR_STANDARD.restZ, `${pack.id} / ${s.name}: the car starts on the floor`);
    }
  }
});

// ---- geometry ------------------------------------------------------------------------------

/** 26 unit directions (cube corners, edge midpoints, face centres) for sampling a sphere's surface. */
const DIRS = [];
for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) for (const dz of [-1, 0, 1]) {
  if (dx === 0 && dy === 0 && dz === 0) continue;
  const n = Math.hypot(dx, dy, dz);
  DIRS.push([dx / n, dy / n, dz / n]);
}

/** The ball (centre and 26 surface points) inside the playable volume (arenaMesh.isInsideArena: bowl, ramps, ceiling arcs, goal chambers). */
function ballInside(p) {
  const r = BALL.radius - 1; // resting on the floor puts the lowest point at ~ -1.9 uu
  if (!isInsideArena(p[0], p[1], p[2])) return 'centre outside';
  for (const d of DIRS) {
    const q = [p[0] + d[0] * r, p[1] + d[1] * r, p[2] + d[2] * r];
    if (!isInsideArena(q[0], q[1], Math.max(q[2], 0))) return `surface point (${q.map((v) => v.toFixed(0))}) outside`;
  }
  return null;
}

/** The 8 corners of the car's hitbox (yaw only) inside the playable volume, with the car on the flat floor. */
function carInside(car) {
  const [hx, hy, hz] = CAR_STANDARD.hitboxSize;
  const [ox, , oz] = CAR_STANDARD.hitboxOffset;
  const c = Math.cos(car.yaw);
  const s = Math.sin(car.yaw);
  for (const fx of [ox - hx / 2, ox + hx / 2]) {
    for (const fy of [-hy / 2, hy / 2]) {
      for (const fz of [oz - hz / 2, oz + hz / 2]) {
        const x = car.pos[0] + fx * c - fy * s;
        const y = car.pos[1] + fx * s + fy * c;
        const z = car.pos[2] + fz;
        if (!isInsideArena(x, y, z)) return `corner (${x.toFixed(0)}, ${y.toFixed(0)}, ${z.toFixed(0)}) outside`;
        // Off the floor ramps: the car must sit flat (no corner closer than a ramp to a side / back wall,
        // except in the open goal mouth where the floor runs on into the goal).
        const ax = Math.abs(x);
        const ay = Math.abs(y);
        if (ax > ARENA.extentX - ARENA.sideRampRadius) return `corner (${x.toFixed(0)}, ${y.toFixed(0)}) on the side ramp`;
        if (ay > ARENA.extentY - ARENA.backRampRadius && ax > ARENA.goalHalfWidth) return `corner (${x.toFixed(0)}, ${y.toFixed(0)}) on the back ramp`;
        const dx = ax - ARENA.cornerCentreX;
        const dy = ay - ARENA.cornerCentreY;
        if (dx > 0 && dy > 0 && Math.hypot(dx, dy) > ARENA.cornerRadius - ARENA.sideRampRadius) return `corner (${x.toFixed(0)}, ${y.toFixed(0)}) on a corner ramp`;
      }
    }
  }
  return null;
}

/** Distance from the ball centre to the car's hitbox (oriented box, yaw only). */
function ballToCar(car, p) {
  const [hx, hy, hz] = CAR_STANDARD.hitboxSize;
  const [ox, , oz] = CAR_STANDARD.hitboxOffset;
  const c = Math.cos(car.yaw);
  const s = Math.sin(car.yaw);
  const cx = car.pos[0] + ox * c;
  const cy = car.pos[1] + ox * s;
  const cz = car.pos[2] + oz;
  const dx = p[0] - cx;
  const dy = p[1] - cy;
  const dz = p[2] - cz;
  const lx = dx * c + dy * s;
  const ly = -dx * s + dy * c;
  const qx = Math.max(Math.abs(lx) - hx / 2, 0);
  const qy = Math.max(Math.abs(ly) - hy / 2, 0);
  const qz = Math.max(Math.abs(dz) - hz / 2, 0);
  return Math.hypot(qx, qy, qz);
}

test('every shot starts with car and ball inside the arena and apart', () => {
  assert.equal(ballInside([0, 0, BALL.restZ]), null, 'centre spot');
  const L = ARENA.extentY;
  const W = ARENA.extentX;
  assert.equal(ballInside([0, L + 400, 200]), null, 'inside a goal');
  assert.notEqual(ballInside([W - 50, 0, 500]), null, 'into the side wall');
  assert.notEqual(ballInside([0, L - 220, ARENA.height - 60]), null, 'into the back ceiling arc');
  assert.notEqual(ballInside([ARENA.goalHalfWidth + 300, L - 20, 300]), null, 'into the back wall beside the goal');
  const k = Math.SQRT1_2;
  const rc = ARENA.cornerRadius - 60;
  assert.notEqual(ballInside([ARENA.cornerCentreX + rc * k, ARENA.cornerCentreY + rc * k, 600]), null, 'into a rounded corner wall');
  assert.notEqual(carInside({ pos: [W - 300, 0, 17], yaw: 0 }), null, 'car on the side ramp');
  assert.notEqual(carInside({ pos: [ARENA.cornerCentreX + 1300 * k, ARENA.cornerCentreY + 1300 * k, 17], yaw: 0 }), null, 'car on a corner ramp');
  for (const pack of P.TRAINING_PACKS) {
    for (const s of pack.shots) {
      const where = `${pack.id} / ${s.name}`;
      assert.equal(ballInside(s.ball.pos), null, `${where}: ball ${ballInside(s.ball.pos)}`);
      assert.equal(carInside(s.car), null, `${where}: car ${carInside(s.car)}`);
      const d = ballToCar(s.car, s.ball.pos);
      assert.ok(d > BALL.radius + 50, `${where}: ball ${d.toFixed(0)} uu from the car hitbox`);
    }
  }
  assert.equal(ballInside(P.FREEPLAY_BALL.pos), null);
  assert.equal(carInside(P.FREEPLAY_CAR_SPAWN), null);
});

// ---- physics -------------------------------------------------------------------------------

/**
 * Play shot `index` of `pack` through a TrainingSession with no input after the release. Returns
 * the result, its time, the player's touches before it and the ball at the end.
 */
function playUntouched(pack, index) {
  sim.createArena();
  const carId = sim.addCar(T.Team.Blue);
  const ctrl = T.emptyControls();
  const out = { result: null, touches: 0, ticks: 0 };
  const hooks = {
    placeShot(shot) {
      sim.resetKickoff();
      sim.setCarState(carId, shot.car.pos, [shot.car.yaw, 0, 0], ZERO, ZERO);
      sim.setCarBoost(carId, shot.car.boost);
      sim.setBallState(shot.ball.pos, ZERO, ZERO);
      sim.sync();
    },
    releaseShot(shot) {
      if (shot.car.vel !== undefined) sim.setCarState(carId, shot.car.pos, [shot.car.yaw, 0, 0], shot.car.vel, ZERO);
      sim.setBallState(shot.ball.pos, shot.ball.vel, shot.ball.angVel);
    },
    shotResult(i, pass, reason) {
      if (out.result === null) out.result = { pass, reason, elapsed: session.elapsed };
    },
    packSummary() {},
    freeplayGoal() {},
    freeplayReset() {},
  };
  const session = new TrainingSession(pack, hooks, { storage: null });
  sim.events.onGoal = (team) => session.onGoal(team);
  sim.events.onBallHit = (id) => {
    if (id === carId && out.result === null) {
      out.touches++;
      session.onPlayerTouch();
    }
  };
  sim.events.onBump = undefined;
  session.start();
  session.goTo(index);
  // Frozen until the first input: the sim must not move meanwhile (the Game does not step it).
  const before = sim.buf.slice(T.BALL_OFFSET, T.BALL_OFFSET + 3);
  assert.equal(session.frozen, true);
  session.input(true); // the release; from here on the controls stay at zero
  const ball = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
  const maxTicks = Math.ceil((pack.timeLimitSeconds + P.TRAINING_GRACE_SECONDS + 1) * T.TICK_RATE);
  for (let t = 0; t < maxTicks && out.result === null; t++) {
    session.input(false);
    sim.setControls(carId, ctrl);
    sim.step(1);
    sim.sync();
    const b = sim.buf;
    ball.x = b[T.BALL_OFFSET + T.B_POS];
    ball.y = b[T.BALL_OFFSET + T.B_POS + 1];
    ball.z = b[T.BALL_OFFSET + T.B_POS + 2];
    ball.vx = b[T.BALL_OFFSET + T.B_VEL];
    ball.vy = b[T.BALL_OFFSET + T.B_VEL + 1];
    ball.vz = b[T.BALL_OFFSET + T.B_VEL + 2];
    session.tick(T.TICK_DT, ball);
    out.ticks++;
  }
  out.ball = [ball.x, ball.y, ball.z];
  out.placed = Array.from(before);
  return out;
}

for (const pack of P.TRAINING_PACKS) {
  test(`${pack.id}: untouched, every shot ${pack.category === 'saving' ? 'ends in the blue goal in time' : 'times out without a goal'}`, () => {
    for (let i = 0; i < pack.shots.length; i++) {
      const s = pack.shots[i];
      const r = playUntouched(pack, i);
      const where = `${pack.id} #${i + 1} ${s.name}`;
      for (let k = 0; k < 3; k++) assert.ok(Math.abs(r.placed[k] - s.ball.pos[k]) < 0.5, `${where}: placed at the shot`);
      assert.ok(r.result !== null, `${where}: no result after ${r.ticks} ticks (ball ${r.ball.map((v) => v.toFixed(0))})`);
      if (pack.category === 'saving') {
        assert.equal(r.result.reason, 'conceded', `${where}: ${r.result.reason} at ${r.result.elapsed.toFixed(2)} s, ball ${r.ball.map((v) => v.toFixed(0))}`);
        assert.ok(r.result.elapsed < pack.timeLimitSeconds, `${where}: scored at ${r.result.elapsed.toFixed(2)} s, limit ${pack.timeLimitSeconds} s`);
        assert.equal(r.touches, 0, `${where}: the idle keeper touched the ball`);
        assert.ok(r.ball[1] < 0, `${where}: in the blue goal`);
      } else {
        assert.equal(r.result.reason, 'timeout', `${where}: ${r.result.reason} at ${r.result.elapsed.toFixed(2)} s, ball ${r.ball.map((v) => v.toFixed(0))}`);
        assert.equal(r.result.pass, false);
        assert.ok(r.result.elapsed >= pack.timeLimitSeconds - 1e-6, `${where}: ended at ${r.result.elapsed.toFixed(2)} s`);
      }
    }
  });
}
