# native/ — RocketSim → WebAssembly

The physics of the game is [RocketSim](https://github.com/ZealanL/RocketSim) 2.2.1 (MIT; it bundles
a patched Bullet 3.24 in `libsrc/bullet3-3.24`, zlib), compiled to WebAssembly with Emscripten.
RocketSim is a **git submodule** at `native/RocketSim`, pinned to the v2.2.1 commit
(`f80f9d9`): clone with `--recurse-submodules` or run `git submodule update --init`. The
submodule is never edited: `patch-rocketsim.mjs` mirrors it into `native/build/rocketsim` with our
three patches applied (see "Patches to the physics library") and the build compiles that copy;
`wrapper.cpp` includes its headers from that copy too (never from the submodule: patch 3 changes
the layout of `MutatorConfig`). `wrapper.cpp` implements the C API declared in `rs_api.h`; the
TypeScript side (`src/sim/RocketSimBridge.ts`) talks only to that API and reads one flat
`Float32Array` state buffer whose layout is defined in `src/sim/types.ts`.

## Rebuilding

```
npm run build:wasm            # = powershell -ExecutionPolicy Bypass -File native/build.ps1
npm run test:sim              # node --test tests/  (uses the built wasm)
```

Options: `-Clean` (wipe `native/build/obj`), `-NoLto` (faster link), `-DebugBuild` (`-O1 -g`,
assertions), `-Jobs N` (parallel compiles, default = CPU count), `-EmsdkDir <path>`.

Output: `src/sim/wasm/rocketsim.js` (ES module, default export `createRocketSim()`) and
`src/sim/wasm/rocketsim.wasm` (593,938 bytes = ~580 KB, ~230 KB gzipped; the 8-car state buffer is
zero-initialised `.bss`, so it costs nothing in the binary). `src/sim/wasm/rocketsim.d.ts` is
hand-written (not generated) and must be updated when `rs_api.h` changes. Both generated files are
meant to be committed so the project runs without a C++ toolchain. `native/build/` (objects,
dependency files, link response file, ~4 MB) should be git-ignored.

The build is incremental: objects live in `native/build/obj/` with `-MMD` dependency files, so a
header or source change recompiles only what includes it; a flag or compiler change rebuilds
everything. Compilation is parallel (one `em++` process per translation unit, throttled to
`-Jobs`); a full build takes ~40 s + ~15 s LTO link on a 16-thread machine (the very first link
also builds Emscripten's LTO system libraries, +30 s, cached afterwards).

### Emscripten SDK

Expected at `tools/emsdk` (git-ignored). Install:

```
cd tools/emsdk
python emsdk.py install latest
python emsdk.py activate latest
```

`build.ps1` does not need `emsdk_env.ps1`; it sets `EMSDK`, `EM_CONFIG`, `EMSDK_PYTHON`,
`EMSDK_NODE` and `PATH` itself from the SDK directory (`$env:EMSDK` or `-EmsdkDir` override it).
Built and tested with Emscripten 6.0.12.

### Flags

Compile: `-std=c++20 -O3 -flto -msimd128 -DRS_DONT_LOG -DRS_MAX_SPEED -DNDEBUG -fno-strict-aliasing`
(RocketSim type-puns its `Vec` to `btVector3`, hence no strict aliasing).
`BT_USE_SSE`/`BT_USE_NEON` are never defined for wasm (Bullet's `btScalar.h` only enables them for
x86/ARM); `BT_USE_DOUBLE_PRECISION` is off; Bullet profiling is off (`BT_NO_PROFILE`).

Link: `-sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createRocketSim -sENVIRONMENT=web,worker,node
-sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16MB -sSTACK_SIZE=1MB -sFILESYSTEM=0 -sASSERTIONS=0
-sDISABLE_EXCEPTION_CATCHING=1 --no-entry`, exporting every `rs_*` function found in `rs_api.h`
plus `_malloc`/`_free`, and the runtime members `HEAPF32, HEAP32, HEAPU8, wasmMemory`.

Exceptions: RocketSim's `RS_ERR_CLOSE` throws; without exception catching a throw aborts the module.
`wrapper.cpp` validates everything (null arena, unknown car id, bad mesh indices, uninitialised
RocketSim) and returns error codes instead, so no code path reaches a throw in normal use.

Loading: the glue locates the wasm with `new URL('rocketsim.wasm', import.meta.url)`, which Vite
rewrites to a hashed asset and Node resolves to the file next to the glue. Vite prints one warning
(`Module "node:module" has been externalized for browser compatibility`) because the glue also
supports Node; that import is only executed when `process.versions.node` exists, never in a
browser. No `locateFile` is needed. For runtimes that forbid `WebAssembly.instantiate(bytes)`
(Cloudflare workerd) the bridge's `RocketSim.load({ wasmModule })` passes the glue's
`instantiateWasm` hook, which does `new WebAssembly.Instance(module, imports)`; the glue consults
that hook before `findWasmBinary` / `fetch` / `instantiateStreaming` / the node `fs` read, so none
of those run (`-sINCOMING_MODULE_JS_API` lists `instantiateWasm` and `wasmBinary`).

### Patches to the physics library

Applied by `native/patch-rocketsim.mjs` (exact text replacements that fail if upstream changes;
marked `// PATCH (turbogol)` in the patched copy, as Bullet's zlib license asks):

1. `libsrc/bullet3-3.24/BulletCollision/BroadphaseCollision/btRSBroadphase.cpp`,
   `_UpdateCellsStatic()`: the per-cell triangle query now casts the arena mesh to
   `btBvhTriangleMeshShape*` (marked `// PATCH`). In this Bullet fork `processAllTriangles()` is
   not virtual, so the original `btTriangleMeshShape*` call bound to the brute-force base version
   and visited every triangle for every one of the ~5800 broadphase cells. That happened at arena
   creation, on the first tick (Bullet re-inserts static AABBs padded by the contact threshold), at
   destruction, and again for the ball-prediction arena: ~1.3 s of stalls at game start in wasm.
   The cast is exactly what the fork's own `btConcaveShape::processAllTriangles` does for this
   shape type, so the set of reported triangles (and therefore the physics) is unchanged. With the
   patch: arena create ~20 ms, destroy ~10 ms.
2. `src/Sim/Arena/Arena.h`: `_cars` is an `std::unordered_set<Car*>` hashed, by default, by
   pointer value, and RocketSim iterates it for the per-tick car updates in `Arena::Step`, the
   boost pad pickups and the kickoff spot assignment. Its iteration order therefore depended on
   heap addresses: the same seeded 3v3 bots-vs-bots run diverged between two processes whose wasm
   heap was laid out differently (under node, a longer `process.argv[1]` was enough: the glue
   stores it in the environ strings). The patch (`// PATCH`, `CarIdHash`) hashes cars by their
   sequential `id`, so the order depends only on the ids and the insert / erase sequence. The
   wrapper deals its own kickoff spots in creation order from the seed and chooses respawn spots
   from the sim state (see "Field layout"), so a seed reproduces a whole match, demolitions
   included (`scripts/smoke-match.mjs` prints identical runs from any path).
3. `src/Sim/MutatorConfig/MutatorConfig.h` and `src/Sim/Car/Car.cpp`: a `carMaxSpeed` mutator
   (default `RLConst::CAR_MAX_SPEED`, also added to RocketSim's own mutator serialisation list),
   for the experimental physics presets (see "Physics mutators"). `Car::_FinishPhysicsTick` clamps
   the car's speed to it and `Car::_PostTickUpdate` scales `SUPERSONIC_START_SPEED` and
   `SUPERSONIC_MAINTAIN_MIN_SPEED` by `carMaxSpeed / CAR_MAX_SPEED`. Both changes are a branch on
   `carMaxSpeed != CAR_MAX_SPEED`: at the stock value the original constant expressions run, so
   stock physics stays bit-identical (the golden trace, `tests/stock-trace.test.mjs`). The flip's
   `forwardSpeedRatio` (`|forward speed| / CAR_MAX_SPEED`, which sizes the dodge impulse) keeps the
   constant: above 2300 uu/s a dodge is a little stronger. Every other field the presets set was
   already a `MutatorConfig` field that RocketSim reads each tick in place of its constant.

Everything else compiles unmodified under Emscripten 6. `<filesystem>` is only used by
`RocketSim::Init()` (file loading), which the wrapper never calls; the mesh is passed in memory
through `rs_init_arena_mesh` and `RocketSim::InitFromMem({}, true)`.

## Wrapper semantics (things the other modules rely on)

* **Units/axes**: uu and sim coordinates on both sides of the C API (x side, y length, z up; blue
  goal at -y). Bullet units never cross the boundary.
* **Arena mesh**: `rs_init_arena_mesh` builds a `btBvhTriangleMeshShape` with internal-edge info
  exactly like RocketSim does for its own collision mesh files, and registers it as the SOCCAR
  mesh. RocketSim itself adds infinite planes for the floor (z = 0), the ceiling and the two side
  walls; the wrapper moves the ceiling and side-wall planes to our field (see "Field layout"), so
  the mesh only has to provide the back walls / goals / corners / ramps. Degenerate triangles are
  skipped. Call it before `rs_arena_create`; to replace the mesh, destroy the arena first (error 3).
* **Field layout**: see the section below; `rs_arena_create` returns 4 until one was set.
* **Car slots**: slot order = creation order, at most `MAX_CARS` = 8 (4v4; the UI exposes up to 3v3).
  `rs_add_car` returns 0 when the arena is full (the bridge throws `MAX_CARS (8) reached`), it never
  writes past the car region. Slots are COMPACT: `rs_remove_car` erases the car from the wrapper's
  vector, so every car created after it moves down one slot and the trailing slot is zeroed. Ids
  never change and are never reused, so callers keep ids and re-resolve with `slotOf(id)` (the
  bridge syncs the buffer inside `removeCar()`, and `carIdOf` / `teamOf` / `slotsOfTeam` read the
  same buffer).
* **Kickoff**: `rs_reset_kickoff(seed)` is the wrapper's own reset on OUR kickoff spots (the
  field layout's 5 blue spots, red mirrored). The seed shuffles the spot list once
  (`std::default_random_engine(seed)` + `std::shuffle`; seed -1 draws the seed from RocketSim's
  global engine) and the k-th car of each team in CREATION order takes spot `order[k]`, so blue
  car k and red car k are mirrored, 2v2 / 3v3 / 4v4 sit on distinct spots
  (`tests/sim.test.mjs` 17-18, 21) and a seed fully determines the line-up. (RocketSim's own
  `ResetToRandomKickoff` hands its spots out in the iteration order of its
  `std::unordered_set<Car*>`; with the default pointer hash that was heap-address order, which
  made a seeded bots-vs-bots match depend on the process memory layout.) A sixth car per team
  goes to the respawn spots (stacked 250 uu further upfield per round). Like RocketSim's reset:
  every car gets a fresh state with the kickoff boost (33.3) at rest height, the ball rests on the
  centre spot, every pad is active; a seeded kickoff also pins RocketSim's global engine.
* **New cars**: `rs_add_car` puts the car on a respawn spot of its team (the k-th car of the team
  on spot `k % 4`, stacked upfield past 4) instead of RocketSim's random one.
* **Demolition respawn**: `rs_step` runs the arena one tick at a time (`Arena::Step(n)` is the
  same loop); a car whose respawn timer ran out during a tick sits on RocketSim's own respawn
  spot (its rigid body was disabled for that tick, so nothing touched it there) and is moved
  right after the tick onto one of OUR respawn spots, facing upfield at the respawn height (36),
  boost kept. The spot depends only on shared state: a hash of (tick count, car id) picks the
  first spot to try and spots another live car stands on (within 300 uu) are skipped while a
  free one exists. Every peer, the host and a replay after `rs_load_state` therefore agree
  (`tests/sim.test.mjs` 24-25); RocketSim's global random engine no longer affects the state.
* **Wheel order**: RocketSim creates wheels `[FR, FL, BR, BL]` (first wheel of each pair has
  `connectionPointOffset.y > 0`, and car-local +y is RIGHT). The state buffer re-orders them to
  `types.ts` order `[FL, FR, BL, BR]`. `C_WHEEL_SUSPENSION` is Bullet's current suspension length
  in uu: wheel centre (car local) = `connectionPointOffset` (y mirrored for the left side) +
  `(0, 0, -suspensionLength)`. Note RocketSim passes `restLength - 12` to Bullet, so an unloaded
  wheel reports `rest - 12 + 12`.
* **Steer sign**: `steer = +1` turns the car to its RIGHT = toward +y from yaw 0 (verified by
  `tests/sim.test.mjs` test 4). `Angle(yaw, 0, 0)` gives forward `(cos yaw, sin yaw, 0)`.
* **Goals**: RocketSim calls the goal callback every tick while the ball is inside a net. The
  wrapper counts a goal only on the first such tick (a new goal needs at least one tick with the
  ball outside, or an `rs_set_ball_state` / `rs_reset_kickoff`). `H_LAST_GOAL_TEAM` is the team
  that SCORED (ball in the +y net → blue).
* **Bumps**: one callback per bump (RocketSim's 0.25 s per-pair cooldown applies).
* **Ball hit info**: RocketSim 2.2.1 stores hit info per car; the ball's `B_HIT_*` fields are the
  most recent valid car hit. `C_BALL_HIT_TICK` is -1 until the car touches the ball.
* **Ball prediction**: `rs_ball_pred_update` lazily creates RocketSim's `BallPredTracker` (a
  second, car-less arena; the bridge triggers this inside `createArena()` so it never stalls a
  frame) and is incremental afterwards (~10-40 µs when the ball is undisturbed). The first update
  after a car touch or a ball reset is a full 720-tick re-simulation (~5 ms); while a car is in
  sustained contact with the ball every update is a full re-simulation, so call it every 4-8
  ticks rather than every tick. Entry `t` = ball state after `t+1` ticks.
* **rs_set_car_state** is a teleport: fresh `CarState` (no jump/flip/demo timers) with boost kept.
* **rs_set_ball_state**: a ball placed with exactly zero velocity above the rest height gets a
  -0.001 uu/s nudge, because `Arena::Step` puts a zero-velocity ball to sleep (kickoff
  optimisation) and it would otherwise float in mid-air forever.
* **rs_set_unlimited_boost** sets every car's boost to 100 before (and after) each tick.
* **Physics mutators** (`rs_set_mutators` / `rs_get_mutators`): see the section below.
* **rs_get_boost_pad(i, out4)**: x, y, z, isBig of pad `i` as the arena simulates it (the
  bridge's `boostPadInfo`; `tests/sim.test.mjs` 22 checks it against `constants.ts`).
* **tickRate** outside [15, 120] falls back to 120 (RocketSim asserts that range).
* **Solver**: stock RocketSim settings (Bullet's warm starting stays on; see "Full state save /
  load" below for the measurement behind that).

## Field layout

The field is ours (`src/sim/constants.ts`), not RocketSim's built-in soccar layout. The bridge's
`initArena(mesh)` uploads the mesh and then calls `rs_set_field_layout(data, count)` with
`fieldLayoutData()` (`src/sim/RocketSimBridge.ts`); the float layout is documented in
`rs_api.h`: version 1, `extentX`, `height`, `goalLineY`, the broadphase bounds, the kickoff spots,
the respawn spots and the boost pads (x, y, z, isBig). It is validated as a whole (finite values,
spots inside the field, bounds enclosing it, exactly `NUM_BOOST_PADS` = 32 pads: the state buffer
has that many pad slots) and kept for every arena created afterwards; while an arena exists it is
refused (3). `rs_arena_create` then:

* passes the bounds as `ArenaConfig.minPos` / `maxPos` (RocketSim's custom broadphase grid; ours
  is (-4700, -6860, 0)..(4700, 6860, 2450), enclosing both goal chambers) and the pads as
  `useCustomBoostPads` / `customBoostPads` (big pads first, in state-buffer order);
* moves RocketSim's side-wall planes to x = ±`extentX` and its ceiling plane to z = `height`
  (static bodies with an unbounded AABB: only their world transform changes, the broadphase is
  untouched; the floor plane stays at z = 0);
* sets `MutatorConfig.goalBaseThresholdY = goalLineY`, so `Arena::IsBallScored` (and the goal
  callback) fire when |ball.y| > goalLineY + ball radius (5600 + 91.25).

The ball predictor's own arena (`BallPredTracker`) is created from the same `ArenaConfig`; its
constructor predicts once before the wrapper can move its planes, so the wrapper moves them, copies
the arena's `MutatorConfig` into it (see "Physics mutators") and re-predicts immediately
(`CreatePredTracker`).

## Physics mutators (experimental presets)

`rs_set_mutators(data, 19)` sets 18 `MutatorConfig` fields of the current arena at once (layout v1
in `rs_api.h` and `src/sim/mutatorLayout.ts`: gravity z, ball top speed / hit scale / mass / bounce /
drag, car top speed (patch 3), boost acceleration ground / air, boost use, spawn boost, first-jump
impulse and hold acceleration, unlimited flips / double jumps, bump scale, demo mode, respawn
delay). `rs_get_mutators(out, cap)` reads them back (a fresh arena returns `STOCK_MUTATORS` bit for
bit). The bridge applies a preset only through `createArena(tickRate, mutators)`, right after
`rs_arena_create`, before any car and before the predictor warm-up; every other caller (the Worker,
roomHost, community nodes, ranked, casual, training packs) passes nothing and gets the stock arena.

* **Validation, all or nothing.** The pointer, the count (19), the version (1), every value finite and
  inside its hard limit (wider than the UI ranges of `src/game/physicsRules.ts`: gravity -2000..-100,
  ball top speed 1000..8500, car top speed 1500..2700, restitution 0..0.95, ...), toggles exactly
  0 / 1, the demo mode exactly 0 / 1 / 2: on any failure nothing changes (code 1; 2 = no arena).
  The limits keep the sim sane whatever a modified client sends: gravity always pulls down, the ball
  moves at most 71 uu per tick (0.78 of its radius: it cannot tunnel through the thin goal and
  corner mesh), a bounce never gains energy, a car moves at most 22.5 uu per tick against its
  19.3 uu half hitbox height.
* **Only these fields.** The wrapper copies the arena's config and changes these fields only:
  `carMass` (RocketSim 2.2.1's `SetMutatorConfig` would give every car the BALL's mass on a car-mass
  change, Arena.cpp:39), `ballRadius` (the broadphase throws above ~105.8 uu, and the renderer,
  goal line and bots assume it) and the goal threshold are never touched.
* **Ball mass** rebuilds the ball's rigid body (RocketSim removes it from the Bullet world and adds a
  new one). The wrapper carries the ball's exact Bullet state over, and refuses the change once a
  car exists (code 3): applied before the cars, the Bullet object order is the same on every peer.
* **Gravity** is given to every non-static body explicitly: Bullet's `setGravity` only reaches
  ACTIVE bodies, and `Arena::Step` puts a ball at rest to sleep (the predictor arena's ball sleeps at
  the kickoff spot after its first prediction, so without this it kept stock gravity and never
  matched).
* **The predictor shares the config.** `rs_set_mutators` sets the same config on the
  `BallPredTracker`'s arena and re-predicts at once; `CreatePredTracker` copies it for a tracker
  created later. With a mismatch `BallState::Matches()` fails within a few ticks and every update
  becomes a full 720-tick re-simulation (measured with gravity 50 %: 300 updates took 410 ms instead
  of 5 ms); with the copy the predicted ball equals the stepped ball bit for bit
  (`tests/mutators-wasm.test.mjs`).
* **Cost**: nothing per tick (RocketSim reads these fields every tick anyway; patch 3 replaces a
  constant with a field read). The call itself takes microseconds, a ball rebuild microseconds, and
  the bridge's existing predictor warm-up is the only prediction.
* **Not in the state.** The config is not in the `rs_save_state` blob or `rs_state_hash`: it is
  constant for the arena's life (other rules mean a new arena), so peers compare
  `mutatorFingerprint(getMutators())` once, before tick 0. `rs_arena_destroy` drops it with the
  arena and `rs_arena_create` always starts stock. `rs_set_demo_mode` still sets the demo mode alone.

## Full state save / load (rollback netcode)

`rs_save_state(out, cap)` serialises the complete dynamic state of the arena into an opaque blob
(returns its length, or -1 when `cap` is too small / no arena), `rs_load_state(data, len)` restores
it on an arena with the same roster (0 ok, 1 no arena, 2 bad magic / version, 3 roster mismatch:
car ids or teams differ per slot, 4 truncated / corrupt; `len` must be exactly the saved length;
a failed load leaves the arena untouched), `rs_state_hash()` is the FNV-1a 32 of the bytes
`rs_save_state` would produce now (offset basis 0x811c9dc5, prime 0x01000193; 0 without an arena),
`rs_state_size_max()` is an upper bound for the current roster (grows with cars; query it after
the roster is complete) and `rs_set_controls_packed(packed, numSlots)` sets the controls of the
first `numSlots` cars from 6 int8 per slot (throttle, steer, pitch, yaw, roll in [-127, 127] ->
`(float)(v / 127.0)`, then a button byte: bit0 jump, bit1 boost, bit2 handbrake; `ClampFix`
applied). The bridge exposes them as `saveState(out)`, `loadState(blob, len?)` (throws with the
code), `stateHash()`, `stateSizeMax()` and `setControlsPacked(packed, numSlots)`.

Guarantees (tested by `tests/sim-state.test.mjs`): `hash(load(blob)) == hash at save time`,
`save(load(blob)) == blob` byte for byte, and `load + replay the same inputs` reproduces the
uninterrupted run bit for bit (hash and state buffer), across instances too (host -> client).

### Blob layout (little-endian)

Every multi-field record is a RocketSim `DataStreamOut` group: `uint32 fieldCount` followed by the
raw fields (`sizeof` each, so `Vec` is 16 bytes incl. its `_w`, `RotMat` 48, `CarControls` 24),
exactly what RocketSim's own `Serialize()` functions emit.

```
'R','S','S','1'  uint32 version (1)  uint32 tickCount  uint8 numCars
per car, slot order:
  uint32 carId  uint8 team
  CarState::Serialize  = uint8 ballHitInfo.isValid [+ group(5) BALLHITINFO fields]
                         + group(30) CARSTATE_SERIALIZATION_FIELDS (lastControls included)
  group(13) anchor     = Vec posBT, Vec velBT (the rigid body's Bullet-unit origin / velocity),
                         uint64 tickCountSinceUpdate, bool isSupersonic, float airTime,
                         bool wheelsWithContact[4], float engineForce, float brake, float steerAngle,
                         float suspensionLength[4], float latFriction[4], float longFriction[4],
                         float extraPushback[4]          (wheel arrays in RocketSim wheel order)
  group(8) controls    = CAR_CONTROLS_SERIALIZATION_FIELDS(car->controls): the PENDING controls
BallState::Serialize   = group(12) BALLSTATE_SERIALIZATION_FIELDS (dsInfo.lastDamageTick zeroed
                         while !hasDamaged: RocketSim leaves it uninitialised)
group(3) ball anchor   = Vec posBT, Vec velBT, uint64 tickCountSinceUpdate
uint8 numPads, per pad: BoostPadState::Serialize = group(3)
```

Sizes: 13 + numCars x (448 with a ball-hit record, 380 without) + 177 (ball) + 417 (32 pads):
2 cars 1367-1503 B, 6 cars 2887-3295 B, 8 cars 3647-4191 B. `rs_state_size_max()` returns
`13 + numCars x 448 + 594`: 3295 for 3v3 and 4191 for 8 cars, both within `MAX_STATE_BYTES` =
8192 in `types.ts` (the bridge also grows its scratch on demand). `rs_load_state` validates the whole structure
(magic, version, roster, every group count and length, exact total length) BEFORE touching the
arena, so a corrupt blob can never reach `DataStreamIn`'s `RS_ERR_CLOSE` (which would abort the
module).

### Why there is more in the blob than RocketSim's own serialisation

RocketSim's `CarState` / `BallState` are not the whole physics state:

1. **Units.** RocketSim keeps pos / vel in uu but Bullet integrates in BT (1 BT = 50 uu), and
   `x * UU_TO_BT * BT_TO_UU` is not the identity in float32. A restore through `Car::SetState`
   would move every body by up to 1 ulp and the replay would drift. The anchors carry the Bullet
   values; the uu fields are then re-derived with `GetState()` exactly as the save did.
2. **Wheel state is physics, not cosmetics.** `Car::_PreTickUpdate` runs the vehicle's
   `calcFrictionImpulses` (reads each wheel's `m_engineForce`, `m_brake`, `m_latFriction`,
   `m_longFriction` and the basis built from `m_steerAngle`) BEFORE `Car::_UpdateWheels` rewrites
   them from this tick's controls: every tick drives with the previous tick's values (a
   one-tick input delay). `btVehicleRL::rayCast` only rewrites `m_extraPushback` while the wheel is
   compressed past its threshold, so it sticks until the wheel leaves the ground. Without these a
   car driving on its wheels replays ~0.1 uu/s off after a single tick (measured).
3. **`isSupersonic`** feeds the supersonic-maintain hysteresis; `airTime` and `wheelsWithContact`
   only fill the state buffer; `suspensionLength` only the wheel transform origin and the buffer.
   All are kept so `rs_sync()` right after a load equals the uninterrupted arena.
4. **Pending controls** (`car->controls`) so a loaded state steps with the same inputs.

Known residual hidden state (NOT in the blob, documented so hash mismatches can be understood):

* Bullet's persistent manifolds: the **warm-start impulse** of every cached contact point, the
  **point caches** themselves (up to 4 points per pair, their order and lifetime) and the **order
  of transient manifolds** (car-car, car-ball pairs) in the dispatcher, which fixes the solver's
  constraint order. Measured with the save / load round trips: no effect. 42 slow- and
  resting-contact scenarios (ball rolling at 3.7-220 uu/s, settling, resting in a corner / against
  a wall, a car on its roof, on its side against a wall, nose against a wall under throttle, two
  cars pushing each other, a car pushing the ball) replay bit-identically after a load for 1, 10
  and 120 ticks, warm starting on, and the suite's contact-heavy round trips (ball hits and bumps
  inside the replay windows) are exact too: with Bullet's 10 solver iterations these small contact
  systems converge to the same float fixed point from any starting impulse. The wrapper therefore
  keeps RocketSim's stock solver settings (an experiment with `SOLVER_USE_WARMSTARTING` cleared
  gave identical results and was reverted). The theoretical residue: a configuration with enough
  contacts that 10 iterations do not converge (a car wedged with its hitbox on several points) could
  differ in the last bits. Loads do not clear the caches on purpose: for a same-arena rollback the
  pre-load cache is the closest match to the authority's.
* RocketSim's global `std::default_random_engine`: not serialised, and no longer part of the
  state either: RocketSim still draws from it when a car respawns, but the wrapper then moves the
  car to a respawn spot chosen from the tick count and the car id (see "Demolition respawn").
* The wrapper's goal / bump counters (`H_GOAL_COUNT`, `H_BUMP_COUNT`) are monotonic event
  counters, not sim state: a load keeps them, so replaying a tick that scored fires `onGoal`
  again. The de-dup state is re-armed on load (a ball already inside a net is the same goal
  continuing; anywhere else the next entry is a new goal). The bridge resets its per-car ball-hit
  baseline on load so the load itself never fires `onBallHit`.
* The ball predictor keeps its own tick counter; after a load with a lower tick it re-predicts in
  full on the next `rs_ball_pred_update` (the bridge resets `predTick`).
* The physics mutators (`MutatorConfig`): constant for the arena's life and fingerprinted
  separately (see "Physics mutators").

Cost (node 24, 6 cars, 3049-byte blob, `tests/sim-state.test.mjs` g): save + load 16.7 us,
save 9.8 us, hash 13.0 us, `setControlsPacked` 0.26 us. Nothing is allocated per call: the
wrapper keeps one reserved `DataStreamOut` / `DataStreamIn` pair and the bridge one wasm scratch.

## Performance (node 24 / V8, 16-thread desktop, numbers from `npm run test:sim` and the profiling
scripts used during development)

| Scenario                                   | per tick | ticks/s |
|--------------------------------------------|----------|---------|
| ball only                                  | 1.4 µs   | 690k    |
| 1 car                                      | 7.8 µs   | 129k    |
| 1v1, `step(1)` + `sync()` every tick       | 14 µs    | 71k     |
| 1v1 + ball prediction every 4 ticks        | 16 µs    | 64k     |
| 2v2 + sync                                 | 28 µs    | 35k     |
| 3v3 + sync + ball pred every 4, all 6 cars chasing the ball (test 20) | 42 µs | 24k |

One-time: module instantiate ~1 ms, `initArena` (BVH + internal edges, 2556 tris) ~17 ms,
`createArena` ~20-28 ms (includes the predictor arena), `destroyArena` ~10 ms, kickoff reset
~0.3 ms.

## Tests

`tests/sim.test.mjs` (node --test) exercises the whole bridge against the built wasm: car config
numbers, throttle/boost/supersonic speeds, steer sign, jump, ball drop and rest height, goal
events and de-duplication, kickoff spawns (1v1, 2v2, 3v3, 4v4: distinct spots of our layout per
team, red mirrored, deterministic per seed), the field layout in the wasm (our pads, goal line,
moved wall / ceiling planes, new-car and demolition respawn spots, the respawn replayed from a
saved state on another instance, `rs_set_field_layout` validation), ball prediction accuracy, performance (1v1: 12000 ticks in
< 1.5 s, actual ~0.2 s; 3v3 with every car chasing the ball: 12000 ticks in < 2.5 s, actual
~0.5 s), the buffer layout against `types.ts` (32 pads at `PADS_OFFSET` = 560, 8 car slots,
padding stays zero), `addCar` past `MAX_CARS` throwing without aborting the module, the team helpers and
slot compaction on `removeCar`, and arena re-creation. It uses `src/sim/arenaMesh.ts` when
present and falls back to a minimal two-goal mesh otherwise. Node strips TypeScript types natively
but does not add file extensions to bare relative imports, so the test registers a small
`node:module` resolve hook that maps `./x` to `./x.ts`.

`tests/sim-state.test.mjs` covers the save / load API: round trips (save, play on, load, replay
the same inputs: identical hash and state buffer; random and ball-chasing inputs, 1v1 and 3v3,
several save points), pending controls in the blob, every error code with the arena left
untouched, hash properties, packed == float controls, determinism of two instances over 1200
ticks with a cross-instance load, `load({ wasmModule })` (the workerd path, via
`WebAssembly.compile` in node) and `load({ wasmBinary })`, and the save + load cost.
