// Prepares the physics library sources for the wasm build: mirrors the pristine RocketSim submodule
// (native/RocketSim, pinned to v2.2.1) into native/build/rocketsim and applies our patches there,
// so the submodule itself is never modified. Only files whose content changed are written, so the
// incremental build (native/build.ps1, object files keyed on mtimes) stays incremental.
// Line-ending agnostic (the upstream files mix CRLF and LF); fails loudly when a patch no longer
// matches (a submodule bump must re-check them).
//
//   node native/patch-rocketsim.mjs            (native/build.ps1 runs it before compiling)
//   ROCKETSIM_SRC=<dir> ROCKETSIM_OUT=<dir> node native/patch-rocketsim.mjs   (other locations)
//
// The patches, also described in native/README.md ("Patches to the physics library"):
//   1. Bullet btRSBroadphase::_UpdateCellsStatic: query arena triangles through the BVH
//      (processAllTriangles is not virtual in this Bullet fork; same triangles, ~60x faster setup).
//   2. RocketSim Arena::_cars hashed by car id instead of by pointer: iteration order (car updates,
//      pad pickups, kickoff assignment) independent of heap addresses -> deterministic replays.
//   3. RocketSim MutatorConfig::carMaxSpeed (stock RLConst::CAR_MAX_SPEED): Car::_FinishPhysicsTick
//      clamps the car to it and Car::_PostTickUpdate scales the supersonic thresholds with it. At the
//      stock value both run their original constant expressions (bit-identical stock physics).
// All are marked "// PATCH (turbogol)" in the patched files, as the zlib license asks for altered
// Bullet sources.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = process.env.ROCKETSIM_SRC ?? join(here, 'RocketSim');
const out = process.env.ROCKETSIM_OUT ?? join(here, 'build', 'rocketsim');

const PATCHES = [
  {
    file: 'libsrc/bullet3-3.24/BulletCollision/BroadphaseCollision/btRSBroadphase.cpp',
    find: '\t\t\t\t\tauto triMeshShape = (btTriangleMeshShape*)colObj->m_collisionShape;\n',
    replace:
      '\t\t\t\t\t// PATCH (turbogol): processAllTriangles() is not virtual in this Bullet\n' +
      '\t\t\t\t\t// fork, so a btTriangleMeshShape* call binds to the brute-force base version (every\n' +
      '\t\t\t\t\t// triangle, for every cell). Arena meshes are always btBvhTriangleMeshShape: use the BVH.\n' +
      '\t\t\t\t\tauto triMeshShape = (btBvhTriangleMeshShape*)colObj->m_collisionShape;\n',
  },
  {
    file: 'src/Sim/Arena/Arena.h',
    find: '\tstd::unordered_set<Car*> _cars;\n',
    replace:
      "\t// PATCH (turbogol): hash cars by id instead of by pointer, so the set's iteration order\n" +
      "\t// (the per-tick car update order in Step(), pad pickups, ResetToRandomKickoff's spot assignment)\n" +
      '\t// depends only on the car ids and the insert / erase sequence, never on heap addresses. With the\n' +
      '\t// default pointer hash the same seeded 3v3 match diverged between processes with a different\n' +
      '\t// heap layout.\n' +
      '\tstruct CarIdHash {\n' +
      '\t\tsize_t operator()(const Car* car) const { return (size_t)car->id; }\n' +
      '\t};\n' +
      '\tstd::unordered_set<Car*, CarIdHash> _cars;\n',
  },
  {
    file: 'src/Sim/Arena/Arena.h',
    find: '\tconst std::unordered_set<Car*>& GetCars() { return _cars; }\n',
    replace: '\tconst std::unordered_set<Car*, CarIdHash>& GetCars() { return _cars; }\n',
  },
  // 3. The car's top speed as a mutator (Turbogol's experimental physics presets set it through
  //    rs_set_mutators). Every other MutatorConfig field the presets use already replaces its
  //    constant in RocketSim.
  {
    file: 'src/Sim/MutatorConfig/MutatorConfig.h',
    find: '\t\tballMaxSpeed = RLConst::BALL_MAX_SPEED,\n',
    replace:
      '\t\tballMaxSpeed = RLConst::BALL_MAX_SPEED,\n' +
      '\t\t// PATCH (turbogol): the car top speed. Car::_FinishPhysicsTick clamps to it and\n' +
      '\t\t// Car::_PostTickUpdate scales the supersonic thresholds by carMaxSpeed / CAR_MAX_SPEED.\n' +
      '\t\tcarMaxSpeed = RLConst::CAR_MAX_SPEED,\n',
  },
  {
    file: 'src/Sim/MutatorConfig/MutatorConfig.h',
    find: 'demoMode, enableTeamDemos, goalBaseThresholdY\n',
    replace: 'demoMode, enableTeamDemos, goalBaseThresholdY, carMaxSpeed /* PATCH (turbogol) */\n',
  },
  {
    file: 'src/Sim/Car/Car.cpp',
    find: '\t\tif (_internalState.isSupersonic && _internalState.supersonicTime < RLConst::SUPERSONIC_MAINTAIN_MAX_TIME) {\n',
    replace:
      '\t\t// PATCH (turbogol): a carMaxSpeed mutator scales the supersonic thresholds by\n' +
      '\t\t// carMaxSpeed / CAR_MAX_SPEED. At the stock top speed the original branches below run.\n' +
      '\t\tif (mutatorConfig.carMaxSpeed != RLConst::CAR_MAX_SPEED) {\n' +
      '\t\t\tfloat speedScale = mutatorConfig.carMaxSpeed / RLConst::CAR_MAX_SPEED;\n' +
      '\t\t\tfloat maintainMinSpeed = RLConst::SUPERSONIC_MAINTAIN_MIN_SPEED * speedScale;\n' +
      '\t\t\tfloat startSpeed = RLConst::SUPERSONIC_START_SPEED * speedScale;\n' +
      '\t\t\tif (_internalState.isSupersonic && _internalState.supersonicTime < RLConst::SUPERSONIC_MAINTAIN_MAX_TIME)\n' +
      '\t\t\t\t_internalState.isSupersonic = (speedSquared >= maintainMinSpeed * maintainMinSpeed);\n' +
      '\t\t\telse\n' +
      '\t\t\t\t_internalState.isSupersonic = (speedSquared >= startSpeed * startSpeed);\n' +
      '\t\t} else if (_internalState.isSupersonic && _internalState.supersonicTime < RLConst::SUPERSONIC_MAINTAIN_MAX_TIME) {\n',
  },
  {
    file: 'src/Sim/Car/Car.cpp',
    find: '\t\tif (vel.length2() > (CAR_MAX_SPEED * UU_TO_BT) * (CAR_MAX_SPEED * UU_TO_BT))\n',
    replace:
      '\t\t// PATCH (turbogol): the top speed is the carMaxSpeed mutator. At the stock value the\n' +
      '\t\t// original constant expression below runs.\n' +
      '\t\tif (mutatorConfig.carMaxSpeed != CAR_MAX_SPEED) {\n' +
      '\t\t\tfloat carMaxSpeedBT = mutatorConfig.carMaxSpeed * UU_TO_BT;\n' +
      '\t\t\tif (vel.length2() > carMaxSpeedBT * carMaxSpeedBT)\n' +
      '\t\t\t\tvel = vel.normalized() * carMaxSpeedBT;\n' +
      '\t\t} else if (vel.length2() > (CAR_MAX_SPEED * UU_TO_BT) * (CAR_MAX_SPEED * UU_TO_BT))\n',
  },
];

function applyPatches(rel, raw) {
  const mine = PATCHES.filter((p) => p.file === rel);
  if (mine.length === 0) return raw;
  const crlf = raw.includes('\r\n');
  let text = raw.replace(/\r\n/g, '\n');
  for (const p of mine) {
    const at = text.indexOf(p.find);
    if (at < 0 || text.indexOf(p.find, at + 1) >= 0) {
      console.error(`patch does not apply cleanly to ${rel} (expected exactly one match of:\n${p.find})`);
      process.exit(1);
    }
    text = text.slice(0, at) + p.replace + text.slice(at + p.find.length);
  }
  return crlf ? text.replace(/\n/g, '\r\n') : text;
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

if (!existsSync(join(src, 'src', 'RocketSim.h'))) {
  console.error(`${src} is empty: run \`git submodule update --init\` first.`);
  process.exit(1);
}

const wanted = new Set();
let written = 0;
for (const dir of ['src', 'libsrc']) {
  for (const full of walk(join(src, dir))) {
    const rel = relative(src, full).replace(/\\/g, '/');
    const target = join(out, rel);
    wanted.add(target);
    const isText = /\.(c|cc|cpp|h|hpp|inl)$/i.test(rel);
    const content = isText ? applyPatches(rel, readFileSync(full, 'utf8')) : readFileSync(full);
    if (existsSync(target)) {
      const cur = isText ? readFileSync(target, 'utf8') : readFileSync(target);
      if (isText ? cur === content : Buffer.compare(cur, content) === 0) continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    written++;
  }
}
// Files that disappeared upstream (after a submodule bump) must not linger in the build tree.
if (existsSync(out)) for (const full of walk(out)) if (!wanted.has(full)) rmSync(full);
console.log(`RocketSim prepared in ${out}: ${PATCHES.length} replacements, ${written} files written`);
