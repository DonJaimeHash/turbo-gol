// Arena physics mesh containment (node --test tests/arena-physics.test.mjs).
// Our analytic arena (src/sim/arenaMesh.ts) is uploaded into RocketSim with our field layout and a
// ball is fired at 3000 uu/s into every rounded corner, the ramps, the ceiling junctions and both
// goals. For 1200 ticks (10 s) the ball centre must stay inside the field's bounding box (|x| <=
// extentX, |y| <= extentY + goalDepth, 0 <= z <= height) AND inside the playable volume itself
// (arenaMesh.isInsideArena, after a 25 uu nudge toward the centre of its region to allow for the
// contact penetration of a fast impact): a hole or an outward facing triangle in the collision
// mesh, or a RocketSim plane left at a wrong place, would let it tunnel out.
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
const { ARENA, BALL } = await import('../src/sim/constants.ts');
const T = await import('../src/sim/types.ts');

const W = ARENA.extentX;
const L = ARENA.extentY;
const H = ARENA.height;
const GW = ARENA.goalHalfWidth;
const GH = ARENA.goalHeight;
const GD = ARENA.goalDepth;
const CX = ARENA.cornerCentreX;
const CY = ARENA.cornerCentreY;
const RC = ARENA.cornerRadius;
const K45 = Math.SQRT1_2;

// The ball centre can never get closer than its radius to a wall; a few uu of contact penetration
// (up to ~15 uu against the floor plane in a straight-down bounce) are allowed on top of that.
const SLACK = 25;
const LIMIT_X = W - BALL.radius + SLACK;
const LIMIT_Y = L + GD - BALL.radius + SLACK;
const LIMIT_Z = H - BALL.radius + SLACK;
const NUDGE = 25;
const SPEED = 3000;
const TICKS = 1200;

const sim = await RocketSim.load();
sim.initArena(buildArenaMesh().physics);

function ballPos() {
  const o = T.BALL_OFFSET + T.B_POS;
  return [sim.buf[o], sim.buf[o + 1], sim.buf[o + 2]];
}

function ballSpeed() {
  const o = T.BALL_OFFSET + T.B_VEL;
  return Math.hypot(sim.buf[o], sim.buf[o + 1], sim.buf[o + 2]);
}

function velocityToward(from, to) {
  const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  return [(d[0] / len) * SPEED, (d[1] / len) * SPEED, (d[2] / len) * SPEED];
}

/** isInsideArena after moving the point NUDGE uu toward the middle of its region (field or goal). */
function insideVolume(x, y, z) {
  const inGoal = Math.abs(y) > L;
  const r = inGoal ? [0, Math.sign(y) * (L + GD / 2), GH / 2] : [0, 0, H / 2];
  const d = [r[0] - x, r[1] - y, r[2] - z];
  const len = Math.hypot(d[0], d[1], d[2]);
  const k = len > NUDGE ? NUDGE / len : 0;
  return isInsideArena(x + d[0] * k, y + d[1] * k, Math.max(0, z + d[2] * k));
}

/** Fire the ball from `from` toward `aim` at 3000 uu/s and check containment every tick. */
function shoot(name, from, aim) {
  sim.createArena();
  assert.ok(isInsideArena(from[0], from[1], from[2]), `${name}: the shot starts inside`);
  sim.setBallState(from, velocityToward(from, aim));
  let maxX = 0;
  let maxY = 0;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let maxCorner = 0;
  for (let t = 1; t <= TICKS; t++) {
    sim.step(1);
    sim.sync();
    const [x, y, z] = ballPos();
    const where = `at tick ${t} (${x.toFixed(0)}, ${y.toFixed(0)}, ${z.toFixed(0)})`;
    assert.ok(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z), `${name}: NaN position at tick ${t}`);
    assert.ok(Math.abs(x) <= LIMIT_X, `${name}: |x| > ${LIMIT_X} ${where}`);
    assert.ok(Math.abs(y) <= LIMIT_Y, `${name}: |y| > ${LIMIT_Y} ${where}`);
    assert.ok(z >= BALL.radius - SLACK && z <= LIMIT_Z, `${name}: z outside [${BALL.radius - SLACK}, ${LIMIT_Z}] ${where}`);
    assert.ok(insideVolume(x, y, z), `${name}: left the playable volume ${where}`);
    if (Math.abs(x) > maxX) maxX = Math.abs(x);
    if (Math.abs(y) > maxY) maxY = Math.abs(y);
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
    const dx = Math.abs(x) - CX;
    const dy = Math.abs(y) - CY;
    if (dx > 0 && dy > 0) maxCorner = Math.max(maxCorner, Math.hypot(dx, dy));
  }
  const speed = ballSpeed();
  console.log(
    `${name}: reach |x|<=${maxX.toFixed(0)} |y|<=${maxY.toFixed(0)} z in [${minZ.toFixed(0)}, ${maxZ.toFixed(0)}], corner radius ${maxCorner.toFixed(0)}, speed after ${TICKS} ticks ${speed.toFixed(0)} uu/s`,
  );
  // The ball must have slowed down (bounces dissipate energy); a ball stuck inside the mesh or
  // pushed out of it keeps accelerating or never touches anything.
  assert.ok(speed < SPEED, `${name}: ball did not lose speed (${speed.toFixed(0)} uu/s)`);
  return { maxX, maxY, minZ, maxZ, maxCorner };
}

/** A point beyond the rounded corner (sx, sy) at plan radius `r` from its centre, along 45 degrees. */
const corner = (sx, sy, r, z) => [sx * (CX + r * K45), sy * (CY + r * K45), z];

test('ball at 3000 uu/s into each rounded floor corner stays inside the arena for 1200 ticks', () => {
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const r = shoot(`corner (${sx > 0 ? '+' : '-'}x, ${sy > 0 ? '+' : '-'}y) low`, [0, 0, 200], corner(sx, sy, RC + 300, 120));
      assert.ok(r.maxCorner > RC - 400, `the shot should actually reach the corner wall (corner radius ${r.maxCorner.toFixed(0)})`);
    }
  }
});

test('ball at 3000 uu/s into each ceiling corner (wall / ceiling arcs over the rounded corner) stays inside', () => {
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const r = shoot(`corner (${sx > 0 ? '+' : '-'}x, ${sy > 0 ? '+' : '-'}y) high`, [sx * 1500, sy * 1500, 300], corner(sx, sy, RC + 300, H + 1500));
      assert.ok(r.maxZ > H - ARENA.ceilingRadius, `the shot should reach the ceiling arc (max z ${r.maxZ.toFixed(0)})`);
    }
  }
});

test('ball at 3000 uu/s from close range straight at the corner wall, the ramps and the ceiling arc', () => {
  // Point-blank shots at the wall geometry (least time for the solver to react).
  shoot('point-blank corner wall', corner(1, 1, RC - 600, 150), corner(1, 1, RC + 200, 150));
  shoot('point-blank corner wall, other quadrant', corner(-1, -1, RC - 600, 400), corner(-1, -1, RC + 200, 400));
  shoot('point-blank corner ramp', corner(-1, 1, RC - 500, 120), corner(-1, 1, RC, 40));
  shoot('point-blank side ramp', [W - 400, 0, 120], [W, 0, 60]);
  shoot('point-blank back ramp', [-2200, -(L - 300), 110], [-2200, -L, 50]);
  shoot('point-blank ceiling arc', [W - 400, 2000, H - 350], [W, 2000, H]);
  shoot('point-blank corner ceiling arc', corner(1, -1, RC - 700, H - 400), corner(1, -1, RC, H));
});

test('ball at 3000 uu/s into both goals (nets, posts, crossbar, rounded back) stays inside', () => {
  for (const sy of [-1, 1]) {
    const tag = sy > 0 ? '+y (blue scores)' : '-y (red scores)';
    const r = shoot(`goal ${tag} centre`, [0, sy * 2000, 150], [0, sy * (L + GD), 200]);
    assert.ok(r.maxY > L + BALL.radius, 'the ball should enter the net');
    assert.ok(r.maxY <= L + GD, 'the ball must stop at the back of the net');
    shoot(`goal ${tag} post`, [-(GW + 300), sy * (L - 2300), 120], [-(GW - 16), sy * L, 300]);
    shoot(`goal ${tag} crossbar`, [300, sy * (L - 2100), 120], [300, sy * L, GH]);
    shoot(`goal ${tag} chamber roof`, [0, sy * (L - 1200), 200], [0, sy * (L + 380), GH]);
    shoot(`goal ${tag} rounded top-back edge`, [0, sy * (L - 800), 300], [0, sy * (L + GD), GH]);
    shoot(`goal ${tag} back corner of the net`, [GW - 300, sy * (L - 900), 150], [GW, sy * (L + GD), 60]);
  }
});

test('ball shot straight up at 3000 uu/s bounces off the ceiling plane at the new height', () => {
  const r = shoot('ceiling', [0, 0, 200], [0, 0, H]);
  assert.ok(r.maxZ > H - BALL.radius - 40, `the ball should reach the ceiling (max z ${r.maxZ.toFixed(0)})`);
});

test('the side walls are at x = +-extentX: a ball rolled at a side wall reaches it', () => {
  const r = shoot('side wall', [0, 0, 600], [W, 0, 600]);
  assert.ok(r.maxX > W - BALL.radius - 40, `the ball should touch the side wall (max |x| ${r.maxX.toFixed(0)})`);
});

test('fast random shots (seeded) never leave the arena', () => {
  let s = 1234567;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < 16; i++) {
    const from = [(rnd() - 0.5) * 1.3 * W, (rnd() - 0.5) * 1.3 * L, 100 + rnd() * 1500];
    const aim = [(rnd() - 0.5) * 2 * W, (rnd() - 0.5) * 2 * (L + GD), rnd() * H];
    shoot(`random ${i}`, from, aim);
  }
});
