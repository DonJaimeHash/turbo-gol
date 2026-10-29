// Chase camera regression tests (node --test tests/camera.test.mjs). Camera.ts only needs
// Vector3 / Quaternion / PerspectiveCamera from three, which load fine in node.
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

const THREE = await import('three/webgpu');
const { ChaseCamera, DEFAULT_CAMERA_SETTINGS, clampToArena, hasViewShift, setViewShift, swivelTarget, SWIVEL_PITCH_STICK_DEG, SWIVEL_PITCH_MOUSE_DEG } =
  await import('../src/render/Camera.ts');
const { ARENA, KICKOFF_SPAWNS } = await import('../src/sim/constants.ts');
const { DEFAULT_CAMERA } = await import('../src/settings.ts');

const DEG = Math.PI / 180;
const FPS = 60;
const DT = 1 / FPS;
const Y_AXIS = new THREE.Vector3(0, 1, 0);

function makeCamera() {
  return new THREE.PerspectiveCamera(70, 16 / 9, 10, 40000);
}

function headingQuat(yawRad) {
  // Car nose = local +x; yaw 0 faces +x, positive toward +z (three frame).
  return new THREE.Quaternion().setFromAxisAngle(Y_AXIS, -yawRad);
}

/** Camera offset from the car, expressed in the car's frame (x along the nose). */
function offsetInCarFrame(cam, carPos, carQuat) {
  const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(carQuat);
  const off = new THREE.Vector3().subVectors(cam.position, carPos);
  return off.dot(fwd);
}

function cameraYaw(cam) {
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
  return Math.atan2(f.z, f.x);
}

function shortest(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

const GROUNDED = { grounded: true, speed: 0, supersonic: false };
const AIRBORNE = { grounded: false, speed: 0, supersonic: false };

test('default framing: 270 behind / ~114 above the car, 110 deg horizontal FOV', () => {
  const cam = makeCamera();
  const chase = new ChaseCamera();
  chase.ballCam = false;
  const carPos = new THREE.Vector3(0, 17, 0);
  const q = headingQuat(0);
  const ball = new THREE.Vector3(0, 93, 3000);
  chase.snapTo(cam, carPos, q, ball, GROUNDED);
  const behind = -offsetInCarFrame(cam, carPos, q);
  assert.ok(Math.abs(behind - DEFAULT_CAMERA_SETTINGS.distance * Math.cos(3 * DEG)) < 2, `arm ${behind}`);
  assert.ok(Math.abs(cam.position.y - (carPos.y + 100 + 270 * Math.sin(3 * DEG))) < 2, `height ${cam.position.y}`);
  const vfov = (2 * Math.atan(Math.tan((110 * DEG) / 2) / (16 / 9))) / DEG;
  assert.ok(Math.abs(cam.fov - vfov) < 0.01, `vertical fov ${cam.fov} vs ${vfov}`);
});

test('car cam recovers behind the car within 0.5 s after a grounded 180 deg heading change', () => {
  const cam = makeCamera();
  const chase = new ChaseCamera();
  chase.ballCam = false;
  const carPos = new THREE.Vector3(0, 17, 0);
  const ball = new THREE.Vector3(0, 93, 3000);
  let q = headingQuat(0);
  chase.snapTo(cam, carPos, q, ball, GROUNDED);
  for (let i = 0; i < FPS; i++) chase.update(cam, carPos, q, ball, GROUNDED, DT);
  assert.ok(offsetInCarFrame(cam, carPos, q) < 0, 'starts behind the car');
  // Teleport-like 180 deg turn (demo respawn / half-flip landing), still grounded.
  q = headingQuat(Math.PI);
  let recoveredAt = -1;
  for (let i = 0; i < FPS; i++) {
    chase.update(cam, carPos, q, ball, GROUNDED, DT);
    if (recoveredAt < 0 && offsetInCarFrame(cam, carPos, q) < -100) recoveredAt = (i + 1) * DT;
  }
  assert.ok(recoveredAt > 0 && recoveredAt <= 0.5, `recovered at ${recoveredAt}s`);
  assert.ok(Math.abs(shortest(cameraYaw(cam), Math.PI)) < 2 * DEG, `camera yaw ${cameraYaw(cam)}`);
});

test('car cam holds its heading through a 0.65 s airborne backflip', () => {
  const cam = makeCamera();
  const chase = new ChaseCamera();
  chase.ballCam = false;
  const carPos = new THREE.Vector3(0, 200, 0);
  const ball = new THREE.Vector3(0, 93, 3000);
  const base = headingQuat(0);
  chase.snapTo(cam, carPos, base, ball, GROUNDED);
  for (let i = 0; i < FPS; i++) chase.update(cam, carPos, base, ball, GROUNDED, DT);
  const before = cameraYaw(cam);
  const frames = Math.round(0.65 * FPS);
  const pitchAxis = new THREE.Vector3(0, 0, 1); // backflip: nose rotates about the car's right axis
  const q = new THREE.Quaternion();
  let maxDev = 0;
  for (let i = 1; i <= frames; i++) {
    q.setFromAxisAngle(pitchAxis, (i / frames) * 2 * Math.PI).premultiply(base);
    chase.update(cam, carPos, q, ball, AIRBORNE, DT);
    maxDev = Math.max(maxDev, Math.abs(shortest(before, cameraYaw(cam))));
  }
  assert.ok(maxDev < 1 * DEG, `camera yaw deviated ${maxDev / DEG} deg during the flip`);
});

test('a zero dt (pause) holds the lagged view instead of snapping to the target', () => {
  const cam = makeCamera();
  const chase = new ChaseCamera(); // ball cam
  const carPos = new THREE.Vector3(0, 17, 0);
  const q = headingQuat(0);
  const ball = new THREE.Vector3(3000, 93, 0);
  chase.snapTo(cam, carPos, q, ball, GROUNDED);
  // Sweep the ball 180 deg/s for one second: the 8.6/s lag leaves the view well behind the target.
  for (let i = 1; i <= FPS; i++) {
    const a = (i / FPS) * Math.PI;
    ball.set(Math.cos(a) * 3000, 93, Math.sin(a) * 3000);
    chase.update(cam, carPos, q, ball, GROUNDED, DT);
  }
  const yawBefore = cameraYaw(cam);
  const posBefore = cam.position.clone();
  chase.update(cam, carPos, q, ball, GROUNDED, 0);
  assert.ok(Math.abs(shortest(yawBefore, cameraYaw(cam))) < 1e-6, 'view direction jumped on dt=0');
  assert.ok(cam.position.distanceTo(posBefore) < 1e-6, 'camera position jumped on dt=0');
  // snapTo still places the camera instantly.
  chase.snapTo(cam, carPos, q, ball, GROUNDED);
  assert.ok(Math.abs(shortest(yawBefore, cameraYaw(cam))) > 1 * DEG, 'snapTo should re-aim');
});

test('the arena clamp keeps the camera inside the glass, ceiling, corners and goal lanes', () => {
  const p = new THREE.Vector3(ARENA.extentX + 500, 100, 0);
  clampToArena(p);
  assert.equal(p.x, ARENA.extentX - 35);
  p.set(0, ARENA.height + 100, 0);
  clampToArena(p);
  assert.equal(p.y, ARENA.height - 35);
  // Beyond the rounded corner (inside the bounding box): pulled back along the corner radius.
  const k = Math.SQRT1_2;
  const out = ARENA.cornerRadius + 200;
  p.set(-(ARENA.cornerCentreX + out * k), 100, -(ARENA.cornerCentreY + out * k));
  clampToArena(p);
  const r = Math.hypot(Math.abs(p.x) - ARENA.cornerCentreX, Math.abs(p.z) - ARENA.cornerCentreY);
  assert.ok(Math.abs(r - (ARENA.cornerRadius - 35)) < 1e-6, `on the inset corner circle (radius ${r})`);
  assert.ok(Math.abs(Math.abs(p.x) - ARENA.cornerCentreX - (Math.abs(p.z) - ARENA.cornerCentreY)) < 1e-6, 'along the radius');
  assert.ok(p.x < 0 && p.z < 0, 'keeps the quadrant');
  // Inside the corner circle: untouched (the square corner a chamfer would cut is still inside).
  const inside = ARENA.cornerRadius - 100;
  p.set(ARENA.cornerCentreX + inside * k, 400, ARENA.cornerCentreY + inside * k);
  const before = p.clone();
  clampToArena(p);
  assert.ok(p.distanceTo(before) < 1e-9, 'inside the rounded corner: untouched');
  p.set(0, 300, ARENA.extentY + 400); // in the goal lane, below the crossbar: allowed
  clampToArena(p);
  assert.equal(p.z, ARENA.extentY + 400);
  p.set(0, 700, ARENA.extentY + 400); // above the crossbar: pulled back into the field
  clampToArena(p);
  assert.equal(p.z, ARENA.extentY - 35);
  p.set(1200, 100, -500); // well inside: untouched
  clampToArena(p);
  assert.deepEqual([p.x, p.y, p.z], [1200, 100, -500]);
});

test('driving along the side wall never puts the camera through the glass', () => {
  const cam = makeCamera();
  const chase = new ChaseCamera();
  chase.ballCam = false;
  const ball = new THREE.Vector3(0, 93, 0);
  const carPos = new THREE.Vector3(ARENA.extentX - 120, 17, -2000);
  const q = headingQuat(Math.PI / 2 - 60 * DEG); // heading mostly +z, angled 60 deg toward the wall... camera swings outward
  chase.snapTo(cam, carPos, q, ball, { grounded: true, speed: 2300, supersonic: true });
  for (let i = 0; i < FPS; i++) {
    carPos.z += 10;
    chase.update(cam, carPos, q, ball, { grounded: true, speed: 2300, supersonic: true }, DT);
    assert.ok(Math.abs(cam.position.x) <= ARENA.extentX - 35 + 1e-6, `camera x ${cam.position.x}`);
  }
});

// ---------------------------------------------------------------------------------------------
// Camera swivel (free look) and rear view.

/** Camera forward (unit) in world space. */
function cameraForward(cam) {
  return new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
}

/** Angle (rad) between the camera's forward and a world direction. */
function angleTo(cam, dir) {
  const d = Math.max(-1, Math.min(1, cameraForward(cam).dot(dir)));
  return Math.acos(d);
}

function cameraPitch(cam) {
  return Math.asin(Math.max(-1, Math.min(1, cameraForward(cam).y)));
}

/** Camera offset from the car along the car's right axis (+ = on the car's right). */
function sideOffset(cam, carPos, carQuat) {
  const right = new THREE.Vector3(0, 0, 1).applyQuaternion(carQuat);
  return new THREE.Vector3().subVectors(cam.position, carPos).dot(right);
}

function assertFinite(cam, label) {
  const p = cam.position;
  const q = cam.quaternion;
  for (const v of [p.x, p.y, p.z, q.x, q.y, q.z, q.w]) assert.ok(Number.isFinite(v), `${label}: NaN in camera transform`);
}

const RIGHT = { x: 1, y: 0, rearView: false };
const BACK = { x: 0, y: 1, rearView: false };
const UP = { x: 0, y: -1, rearView: false };
const NONE = { x: 0, y: 0, rearView: false };
const REAR = { x: 0, y: 0, rearView: true };

/** A settled car cam (or ball cam) on a static car with the ball straight ahead. */
function settled(ballCam, heading = 0, ballPos) {
  const cam = makeCamera();
  const chase = new ChaseCamera();
  chase.ballCam = ballCam;
  const carPos = new THREE.Vector3(500, 17, -300);
  const q = headingQuat(heading);
  const ball =
    ballPos ?? new THREE.Vector3(carPos.x + Math.cos(heading) * 3000, 93, carPos.z + Math.sin(heading) * 3000);
  chase.snapTo(cam, carPos, q, ball, GROUNDED);
  for (let i = 0; i < 2 * FPS; i++) chase.update(cam, carPos, q, ball, GROUNDED, DT);
  return { cam, chase, carPos, q, ball };
}

test('swivelTarget: direction only past the 0.25 deadzone, stick direction mapping, bounded tilt', () => {
  let t = swivelTarget(1, 0);
  assert.ok(t.active && Math.abs(t.yaw - Math.PI / 2) < 1e-9 && t.pitch === 0, 'right = +90 deg');
  t = swivelTarget(-1, 0);
  assert.ok(t.active && Math.abs(t.yaw + Math.PI / 2) < 1e-9 && t.pitch === 0, 'left = -90 deg');
  t = swivelTarget(0, 1);
  assert.ok(t.active && Math.abs(Math.abs(t.yaw) - Math.PI) < 1e-9, 'back = 180 deg');
  t = swivelTarget(0, -1);
  assert.ok(t.active && Math.abs(t.yaw) < 1e-9, 'forward = 0 deg');
  assert.ok(Math.abs(t.pitch - SWIVEL_PITCH_STICK_DEG * DEG) < 1e-9, 'straight up tilts up by the stick limit');
  assert.ok(Math.abs(swivelTarget(0, 1).pitch + SWIVEL_PITCH_STICK_DEG * DEG) < 1e-9, 'straight back tilts down');
  assert.ok(Math.abs(swivelTarget(0, -1, SWIVEL_PITCH_MOUSE_DEG).pitch - 35 * DEG) < 1e-9, 'mouse limit 35 deg');
  // Mouse-style partial deflection: the direction is used, the magnitude is not.
  t = swivelTarget(0.4, 0);
  assert.ok(t.active && Math.abs(t.yaw - Math.PI / 2) < 1e-9, '(0.4, 0) is a full 90 deg');
  t = swivelTarget(0.1, 0);
  assert.ok(!t.active && t.yaw === 0 && t.pitch === 0, '(0.1, 0) is inside the deadzone');
  t = swivelTarget(0, 0);
  assert.ok(!t.active, 'released');
  t = swivelTarget(Number.NaN, 0);
  assert.ok(!t.active && t.yaw === 0 && t.pitch === 0, 'NaN input is inactive');
  // Diagonal: pure orbit, no tilt. Any direction: tilt within the limit, yaw is the direction.
  t = swivelTarget(0.7, -0.7);
  assert.ok(Math.abs(t.yaw - Math.PI / 4) < 1e-9 && Math.abs(t.pitch) < 1e-9, 'diagonal has no tilt');
  for (let a = 0; a < 360; a += 5) {
    const x = Math.sin(a * DEG) * 0.9;
    const y = -Math.cos(a * DEG) * 0.9;
    t = swivelTarget(x, y, 35);
    assert.ok(Math.abs(t.pitch) <= 35 * DEG + 1e-9, `tilt clamped at ${a} deg`);
    assert.ok(Math.abs(shortest(t.yaw, a * DEG)) < 1e-9, `yaw is the stick direction at ${a} deg`);
    assert.ok(a < 90 || a > 270 ? t.pitch >= 0 : t.pitch <= 0, `tilt sign at ${a} deg`);
  }
  // Reusable out object: no allocation on the hot path.
  const out = { active: false, yaw: 0, pitch: 0 };
  assert.equal(swivelTarget(1, 0, 25, out), out);
});

test('stick right: within 0.5 s the camera sits on the car left looking along the car right', () => {
  for (const heading of [0, 0.7, -2.4]) {
    const { cam, chase, carPos, q, ball } = settled(false, heading);
    for (let i = 0; i < Math.round(0.5 * FPS); i++) chase.update(cam, carPos, q, ball, GROUNDED, DT, RIGHT);
    const right = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    assert.ok(angleTo(cam, right) < 10 * DEG, `heading ${heading}: view is ${angleTo(cam, right) / DEG} deg off the car right`);
    assert.ok(sideOffset(cam, carPos, q) < -200, `heading ${heading}: camera should be on the car's left`);
    assert.ok(Math.abs(offsetInCarFrame(cam, carPos, q)) < 60, `heading ${heading}: camera beside the car`);
  }
});

test('stick back: camera in front of the car looking back at it', () => {
  const { cam, chase, carPos, q, ball } = settled(false, 0.3);
  for (let i = 0; i < Math.round(0.5 * FPS); i++) chase.update(cam, carPos, q, ball, GROUNDED, DT, BACK);
  assert.ok(Math.abs(shortest(cameraYaw(cam), 0.3 + Math.PI)) < 10 * DEG, `camera yaw ${cameraYaw(cam) / DEG}`);
  assert.ok(offsetInCarFrame(cam, carPos, q) > 150, 'camera is ahead of the nose');
  // Straight back also tilts down by the stick limit: looking down at the car from the front.
  assert.ok(Math.abs(cameraPitch(cam) - (-3 - SWIVEL_PITCH_STICK_DEG) * DEG) < 2 * DEG, `pitch ${cameraPitch(cam) / DEG}`);
});

test('releasing the swivel returns within 0.6 s at swivelSpeed 5, faster at 10, and swivelSpeed is live', () => {
  const returnTime = (swivelSpeed) => {
    const { cam, chase, carPos, q, ball } = settled(false);
    chase.settings.swivelSpeed = swivelSpeed;
    for (let i = 0; i < FPS; i++) chase.update(cam, carPos, q, ball, GROUNDED, DT, RIGHT);
    assert.ok(Math.abs(shortest(cameraYaw(cam), Math.PI / 2)) < 2 * DEG, 'swivelled');
    for (let i = 1; i <= FPS; i++) {
      chase.update(cam, carPos, q, ball, GROUNDED, DT, NONE);
      if (Math.abs(cameraYaw(cam)) < 5 * DEG) return i * DT;
    }
    return Infinity;
  };
  const t5 = returnTime(5);
  const t10 = returnTime(10);
  assert.ok(t5 <= 0.6, `returned in ${t5}s at swivelSpeed 5`);
  assert.ok(t10 < t5, `swivelSpeed 10 (${t10}s) should be faster than 5 (${t5}s)`);
  // 90 deg in ~0.15 s at the default 5: at least 80% of the way.
  const { cam, chase, carPos, q, ball } = settled(false);
  for (let i = 0; i < Math.round(0.15 * FPS); i++) chase.update(cam, carPos, q, ball, GROUNDED, DT, RIGHT);
  assert.ok(cameraYaw(cam) > 0.8 * (Math.PI / 2), `only ${cameraYaw(cam) / DEG} deg after 0.15 s`);
});

test('rear view cuts to the front in one frame and cuts back on release, in both modes', () => {
  for (const ballCam of [false, true]) {
    const { cam, chase, carPos, q, ball } = settled(ballCam, 0.5);
    const yaw0 = cameraYaw(cam);
    const pos0 = cam.position.clone();
    chase.update(cam, carPos, q, ball, GROUNDED, DT, REAR);
    assert.ok(Math.abs(shortest(cameraYaw(cam), yaw0 + Math.PI)) < 0.5 * DEG, `ballCam ${ballCam}: yaw ${cameraYaw(cam) / DEG}`);
    assert.ok(Math.abs(cameraPitch(cam) - -3 * DEG) < 0.5 * DEG, `ballCam ${ballCam}: pitch is the base angle`);
    assert.ok(offsetInCarFrame(cam, carPos, q) > 150, `ballCam ${ballCam}: camera in front of the car`);
    chase.update(cam, carPos, q, ball, GROUNDED, DT, NONE);
    assert.ok(Math.abs(shortest(cameraYaw(cam), yaw0)) < 0.5 * DEG, `ballCam ${ballCam}: cut back`);
    assert.ok(cam.position.distanceTo(pos0) < 1, `ballCam ${ballCam}: back where it was`);
    // Rear view wins over an active swivel and still cuts.
    for (let i = 0; i < FPS; i++) chase.update(cam, carPos, q, ball, GROUNDED, DT, RIGHT);
    chase.update(cam, carPos, q, ball, GROUNDED, DT, { x: 1, y: 0, rearView: true });
    assert.ok(Math.abs(shortest(cameraYaw(cam), yaw0 + Math.PI)) < 0.5 * DEG, `ballCam ${ballCam}: rear view over swivel`);
  }
});

test('ball cam swivel orbits relative to the car heading, then resumes tracking the ball smoothly', () => {
  // Ball 90 deg to the car's LEFT: ball cam looks at -90 deg; a right swivel must look at +90 deg
  // (car relative), not at 0 deg (ball relative).
  const carPos = new THREE.Vector3(500, 17, -300);
  const ballLeft = new THREE.Vector3(carPos.x, 93, carPos.z - 3000);
  const { cam, chase, q, ball } = settled(true, 0, ballLeft);
  assert.ok(Math.abs(shortest(cameraYaw(cam), -Math.PI / 2)) < 1 * DEG, 'ball cam looks at the ball');
  for (let i = 0; i < FPS; i++) chase.update(cam, carPos, q, ball, GROUNDED, DT, RIGHT);
  assert.ok(Math.abs(shortest(cameraYaw(cam), Math.PI / 2)) < 10 * DEG, `swivel yaw ${cameraYaw(cam) / DEG} (car relative)`);
  let maxStep = 0;
  let prev = cameraYaw(cam);
  for (let i = 0; i < 2 * FPS; i++) {
    chase.update(cam, carPos, q, ball, GROUNDED, DT, NONE);
    const y = cameraYaw(cam);
    maxStep = Math.max(maxStep, Math.abs(shortest(prev, y)));
    prev = y;
  }
  assert.ok(Math.abs(shortest(cameraYaw(cam), -Math.PI / 2)) < 3 * DEG, `back on the ball: ${cameraYaw(cam) / DEG}`);
  assert.ok(maxStep < 60 * DEG, `release should swing, not cut (max step ${maxStep / DEG} deg/frame)`);
});

test('mouse-style partial deflection: (0.4, 0) swivels the full 90 deg, (0.1, 0) does nothing', () => {
  const a = settled(false);
  for (let i = 0; i < FPS; i++) a.chase.update(a.cam, a.carPos, a.q, a.ball, GROUNDED, DT, { x: 0.4, y: 0, rearView: false });
  assert.ok(Math.abs(shortest(cameraYaw(a.cam), Math.PI / 2)) < 2 * DEG, `yaw ${cameraYaw(a.cam) / DEG}`);
  const b = settled(false);
  const before = b.cam.position.clone();
  for (let i = 0; i < FPS; i++) b.chase.update(b.cam, b.carPos, b.q, b.ball, GROUNDED, DT, { x: 0.1, y: 0, rearView: false });
  assert.ok(Math.abs(cameraYaw(b.cam)) < 1e-6 && b.cam.position.distanceTo(before) < 1e-6, 'deadzone ignored');
});

test('vertical swivel tilts by the device limit and clamps; the floor clamp still holds', () => {
  const { cam, chase, carPos, q, ball } = settled(false);
  for (let i = 0; i < FPS; i++) chase.update(cam, carPos, q, ball, GROUNDED, DT, UP);
  assert.ok(Math.abs(cameraPitch(cam) - (-3 + SWIVEL_PITCH_STICK_DEG) * DEG) < 1 * DEG, `stick tilt ${cameraPitch(cam) / DEG}`);
  assert.ok(Math.abs(cameraYaw(cam)) < 1 * DEG, 'straight up keeps the heading');
  assert.ok(cam.position.y >= 10 - 1e-6, `floor clamp: camera y ${cam.position.y}`);
  chase.swivelPitchDeg = SWIVEL_PITCH_MOUSE_DEG;
  for (let i = 0; i < FPS; i++) chase.update(cam, carPos, q, ball, GROUNDED, DT, UP);
  assert.ok(Math.abs(cameraPitch(cam) - (-3 + SWIVEL_PITCH_MOUSE_DEG) * DEG) < 1 * DEG, `mouse tilt ${cameraPitch(cam) / DEG}`);
  // Over-deflected input is still a direction: no more tilt than the limit.
  for (let i = 0; i < FPS; i++) chase.update(cam, carPos, q, ball, GROUNDED, DT, { x: 0, y: -5, rearView: false });
  assert.ok(cameraPitch(cam) <= (-3 + SWIVEL_PITCH_MOUSE_DEG) * DEG + 1e-6, 'tilt clamped');
  // A stick that is mostly sideways only orbits.
  for (let i = 0; i < FPS; i++) chase.update(cam, carPos, q, ball, GROUNDED, DT, { x: 1, y: -0.3, rearView: false });
  assert.ok(Math.abs(cameraPitch(cam) - -3 * DEG) < 1 * DEG, `sideways stick has no tilt: ${cameraPitch(cam) / DEG}`);
});

test('no NaN at kickoff / snapTo with any look, and the swivel snaps with the camera', () => {
  const cam = makeCamera();
  const chase = new ChaseCamera();
  const carPos = new THREE.Vector3(KICKOFF_SPAWNS[2][0], 17, KICKOFF_SPAWNS[2][1]);
  const q = headingQuat(Math.PI / 4);
  const ball = new THREE.Vector3(0, 93, 0);
  for (const look of [NONE, RIGHT, BACK, UP, REAR, { x: Number.NaN, y: Number.NaN, rearView: false }]) {
    chase.snapTo(cam, carPos, q, ball, GROUNDED, look);
    assertFinite(cam, `snapTo ${JSON.stringify(look)}`);
    for (let i = 0; i < 10; i++) {
      chase.update(cam, carPos, q, ball, AIRBORNE, DT, look);
      assertFinite(cam, `update ${JSON.stringify(look)}`);
    }
  }
  // snapTo() with the stick held places the swivelled view instantly.
  chase.ballCam = false;
  chase.snapTo(cam, carPos, q, ball, GROUNDED, RIGHT);
  const right = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  assert.ok(angleTo(cam, right) < 5 * DEG, 'snapped straight into the swivel');
  // The old signature (no look) still works and means no swivel.
  chase.snapTo(cam, carPos, q, ball, GROUNDED);
  assert.ok(Math.abs(shortest(cameraYaw(cam), Math.PI / 4)) < 1e-6, 'no look = normal view');
});

test('settings: a full object is kept by reference (live sliders), a partial one is merged', () => {
  assert.deepEqual(DEFAULT_CAMERA_SETTINGS, DEFAULT_CAMERA);
  const live = { ...DEFAULT_CAMERA };
  const chase = new ChaseCamera(live);
  assert.equal(chase.settings, live, 'same object');
  chase.ballCam = false;
  const cam = makeCamera();
  const carPos = new THREE.Vector3(0, 17, 0);
  const q = headingQuat(0);
  const ball = new THREE.Vector3(0, 93, 3000);
  live.distance = 350;
  chase.snapTo(cam, carPos, q, ball, GROUNDED);
  assert.ok(Math.abs(-offsetInCarFrame(cam, carPos, q) - 350 * Math.cos(3 * DEG)) < 2, 'new distance applied');
  const partial = new ChaseCamera({ fov: 90 });
  assert.equal(partial.settings.fov, 90);
  assert.equal(partial.settings.distance, DEFAULT_CAMERA.distance);
  assert.notEqual(partial.settings, DEFAULT_CAMERA_SETTINGS, 'defaults are never mutated through a partial');
  const none = new ChaseCamera();
  assert.notEqual(none.settings, DEFAULT_CAMERA_SETTINGS);
  none.settings.fov = 1;
  assert.equal(DEFAULT_CAMERA.fov, 110);
});

test('view shift: the garage frame moves the image without squeezing it (setViewShift keeps the aspect)', () => {
  const wide = 1900 / 810;
  const cam = new THREE.PerspectiveCamera(35, wide, 10, 40000);
  const plain = cam.projectionMatrix.clone();
  setViewShift(cam, 0.2, -0.1);
  // three's setViewOffset(1, 1, ...) set the aspect to 1: every later frame drew a square view
  // stretched over the wide window (a visit to the garage, then the match).
  assert.equal(cam.aspect, wide, 'aspect kept');
  assert.ok(hasViewShift(cam, 0.2, -0.1), 'the shift is the one asked for');
  assert.ok(!hasViewShift(cam, 0.2, 0), 'another shift is not');
  const m = cam.projectionMatrix.elements;
  assert.ok(Math.abs(m[0] - plain.elements[0]) < 1e-12 && Math.abs(m[5] - plain.elements[5]) < 1e-12, 'same scale on both axes: nothing stretched');
  assert.ok(Math.abs(m[8]) > 0.1 && Math.abs(m[9]) > 0.05, 'centre moved');
  // A resize keeps the shift as a fraction of the new view, and clearing it leaves the aspect alone.
  cam.aspect = 844 / 390;
  cam.updateProjectionMatrix();
  assert.ok(hasViewShift(cam, 0.2, -0.1), 'still the same fractions after a resize');
  cam.clearViewOffset();
  assert.equal(cam.aspect, 844 / 390, 'clearing the shift keeps the aspect');
  assert.ok(!hasViewShift(cam, 0.2, -0.1));
});
