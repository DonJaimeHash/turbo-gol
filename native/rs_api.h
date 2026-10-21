// C API exported from the RocketSim WebAssembly module (see wrapper.cpp).
// All lengths in uu (1 uu = 1 cm) unless stated, sim coordinates (x side, y length, z up; blue
// goal at -y). Angles in radians. The JS side NEVER sees Bullet units. Matches src/sim/types.ts.
#pragma once
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// ---- Lifecycle --------------------------------------------------------------------------
// Provide the arena collision mesh (indexed triangles, uu, sim coords, normals pointing INTO the
// arena) and initialise RocketSim for SOCCAR. Must be called once before rs_arena_create.
// Returns 0 on success.
int rs_init_arena_mesh(const float* vertices, int numVertices, const int32_t* triangles, int numTriangles);

// Our field layout (src/sim/constants.ts; the bridge sends it from initArena). Must be called
// before rs_arena_create and applies to every arena created afterwards (the ball predictor's arena
// included). `count` floats:
//   [0] layout version (1)
//   [1] extentX: RocketSim's two side-wall planes are moved to x = +-extentX
//   [2] height: its ceiling plane is moved to z = height (the floor plane stays at z = 0)
//   [3] goalLineY: goal threshold (MutatorConfig.goalBaseThresholdY): the ball is in a goal while
//       |ball.y| > goalLineY + ball radius
//   [4..6] broadphase min, [7..9] broadphase max (RocketSim's grid bounds; must enclose the field
//       and both goal chambers)
//   then nKick (1..8) followed by nKick x (x, y, yaw): BLUE kickoff spots (red mirrored: x, y
//       negated, yaw + pi)
//   then nResp (1..8) followed by nResp x (x, y, yaw): BLUE demolition respawn spots (mirrored)
//   then nPads (must equal the state buffer's pad slots, NUM_BOOST_PADS in types.ts) followed by
//       nPads x (x, y, z, isBig 0/1), in state-buffer order (RocketSim custom boost pads)
// Returns 0 ok, 1 bad data (null, count mismatch, non-finite, spots outside the field, bounds not
// enclosing it), 2 wrong pad count, 3 an arena exists (destroy it first).
int rs_set_field_layout(const float* data, int count);

// Create the single global arena (tickRate normally 120). Returns 0 on success, 2 when the mesh
// is missing, 4 when no field layout was set.
int rs_arena_create(float tickRate);
void rs_arena_destroy(void);

// ---- Cars --------------------------------------------------------------------------------
// team: 0 blue, 1 red. preset: see CarPreset in types.ts. Returns the car id (>0) or 0 on error.
// The new car stands on a respawn spot of its team (the k-th car of the team on spot k % nResp,
// stacked 250 uu further upfield per round), not on a random one.
int rs_add_car(int team, int preset);
int rs_remove_car(int carId);
// Writes 22 floats: hitboxSize(3) hitboxOffset(3) frontWheelRadius backWheelRadius
// frontSuspensionRest backSuspensionRest frontWheelOffset(3) backWheelOffset(3) dodgeDeadzone (+ padding).
void rs_get_car_config(int preset, float* out22);
void rs_set_controls(int carId, float throttle, float steer, float pitch, float yaw, float roll,
                     int jump, int boost, int handbrake);
void rs_set_car_state(int carId, float x, float y, float z, float yaw, float pitch, float roll,
                      float vx, float vy, float vz, float avx, float avy, float avz);
void rs_set_car_boost(int carId, float boost);
void rs_set_car_dodge_deadzone(int carId, float deadzone);
void rs_demolish_car(int carId);

// ---- Ball --------------------------------------------------------------------------------
void rs_set_ball_state(float x, float y, float z, float vx, float vy, float vz, float avx, float avy, float avz);

// ---- Simulation --------------------------------------------------------------------------
// Advance the arena by n ticks (1/tickRate each). Goal/bump events are recorded into the state header.
// A car whose demolition respawn timer runs out in a tick is moved onto one of its team's respawn
// spots right after that tick (chosen from the tick count and the car id, skipping spots another
// live car stands on): deterministic, so every peer and the host agree.
void rs_step(int n);
// Refresh the state buffer from the arena (call after stepping, before reading).
void rs_sync(void);
// Pointer to the state buffer (STATE_BUFFER_FLOATS floats). Stable for the module lifetime.
float* rs_state_ptr(void);
// Reset to a kickoff: seed -1 = random. The seed shuffles the kickoff spots once and the k-th car of
// each team (creation order) takes spot k, so both teams mirror each other; ball at rest on the
// centre spot, every pad active, boost 33.3.
void rs_reset_kickoff(int seed);
// Boost pad `index` of the current arena (state-buffer order): writes x, y, z, isBig (0/1) to out4
// and returns 1, or returns 0 (no arena / bad index).
int rs_get_boost_pad(int index, float* out4);
// 1 if the ball is currently inside a goal.
int rs_is_ball_scored(void);

// ---- Ball prediction ---------------------------------------------------------------------
// Update the ball predictor from the current arena ball state and fill the prediction buffer
// (BALL_PRED_TICKS entries of pos(3) vel(3)). Cheap to call every tick (incremental).
void rs_ball_pred_update(void);
// Re-predict every tick from the current ball state, whatever the tracker's history (a full
// re-prediction, ~1-5 ms). The incremental update above reuses its data while the real ball stays
// within a tolerance of the predicted one, so two arenas with the same state but different
// update histories can hold slightly different predictions: lockstep peers call this at agreed
// ticks (after a state load) so their predictions are identical again.
void rs_ball_pred_force(void);
float* rs_ball_pred_ptr(void);

// ---- Mutators ----------------------------------------------------------------------------
// demoMode: 0 normal (supersonic bumps demolish), 1 on any contact, 2 disabled.
void rs_set_demo_mode(int demoMode);
void rs_set_unlimited_boost(int enabled); // keeps boost at 100 every tick when enabled

// Physics mutators of the current arena (RocketSim's MutatorConfig; Turbogol's experimental
// physics presets, src/sim/mutatorLayout.ts). Layout v1, exactly `count` = 19 floats:
//   [0] layout version (1)        [1] gravityZ              [2] ballMaxSpeed
//   [3] ballHitExtraForceScale    [4] ballMass (Bullet mass units, stock 30)
//   [5] ballWorldRestitution      [6] ballDrag              [7] carMaxSpeed
//   [8] boostAccelGround          [9] boostAccelAir         [10] boostUsedPerSecond
//   [11] carSpawnBoostAmount      [12] jumpImmediateForce   [13] jumpAccel
//   [14] unlimitedFlips (0/1)     [15] unlimitedDoubleJumps (0/1)
//   [16] bumpForceScale           [17] demoMode (0/1/2, as rs_set_demo_mode)
//   [18] respawnDelay (s)
// Hard limits (wider than any UI range; the UI's grid lives in src/game/physicsRules.ts): gravityZ
// -2000..-100, ballMaxSpeed 1000..8500, ballHitExtraForceScale 0..4, ballMass 10..90,
// ballWorldRestitution 0..0.95, ballDrag 0..0.5, carMaxSpeed 1500..2700, boostAccelGround 0..3000,
// boostAccelAir 0..3200, boostUsedPerSecond 0..100, carSpawnBoostAmount 0..100, jumpImmediateForce
// 0..600, jumpAccel 0..3000, bumpForceScale 0..5, respawnDelay 0.5..10. All or nothing: a null
// pointer, another count or version, a non-finite value or one outside its limit changes nothing.
// carMass, ballRadius, the goal threshold and every other field are never touched. A ballMass change
// rebuilds the ball body (its state is carried over exactly) and is refused once a car exists, so
// the Bullet object order is the same on every peer. The ball predictor's arena gets the same
// config and re-predicts at once, so predictions follow the preset and stay incremental. Meant to
// be called once, right after rs_arena_create (the bridge's createArena(tickRate, mutators)): a new
// arena always starts stock, and the config is NOT in rs_save_state / rs_state_hash (it never
// changes during a match). Returns 0 ok, 1 bad data, 2 no arena, 3 ballMass change while cars exist.
int rs_set_mutators(const float* data, int count);
// Writes the arena's effective values in the same layout (version first) to `out`. Returns the
// number of floats written (19), or 0 (no arena, null pointer, cap < 19).
int rs_get_mutators(float* out, int cap);


// ---- Full state save / load (netcode rollback, phase 1 online) ------------------------------
// Serialises the complete dynamic state of the arena, Bullet-exact, in creation (slot) order:
// 'R','S','S','1' magic, uint32 version (1), uint32 tickCount, uint8 numCars, then per car:
// uint32 carId, uint8 team, CarState::Serialize (BallHitInfo + the CARSTATE fields incl.
// lastControls), an "anchor" group (Bullet-unit position / velocity, tickCountSinceUpdate,
// isSupersonic, airTime, per-wheel contact / engineForce / brake / steerAngle / suspension /
// friction / pushback: physics state RocketSim does not list but Car::_PreTickUpdate reads) and
// the car's pending controls; then BallState::Serialize + a ball anchor group; then uint8 numPads
// + BoostPadState::Serialize each. Little-endian (DataStreamOut). Layout details and the residual
// hidden state in native/README.md. Returns the byte count, or -1 if cap is too small / no arena.
int rs_save_state(uint8_t* out, int cap);
// Restores a state produced by rs_save_state on an arena with the SAME roster (same car ids in the
// same slot order); returns 0 on success, 1 no arena, 2 bad magic/version, 3 roster mismatch,
// 4 truncated / corrupt. The whole blob is validated BEFORE anything is mutated (a bad blob leaves
// the arena untouched). Restores the arena tick count, every car / ball body straight from the
// anchors (bit-exact: save(load(b)) == b) with the uu fields re-derived, and the pads; re-arms the
// goal de-dup (a ball inside a net = the same goal continuing) and resets the bump de-dup. The
// goal / bump counters of the state buffer are monotonic and untouched. Call rs_sync() afterwards.
int rs_load_state(const uint8_t* data, int len);
// Upper bound of rs_save_state output for the CURRENT roster (13 + numCars * 448 + 594 bytes with
// our 32 pads): query it after the cars are added. 3v3: 3295, 8 cars: 4191 (types.ts
// MAX_STATE_BYTES covers both).
int rs_state_size_max(void);
// FNV-1a 32-bit hash of the bytes rs_save_state would produce (determinism checks / desync detection).
uint32_t rs_state_hash(void);
// Set controls for ALL cars from one packed array (6 int8 per slot, slot order): throttle, steer,
// pitch, yaw, roll in [-127,127] (=> [-1,1]) and a button byte (bit0 jump, bit1 boost, bit2 handbrake).
void rs_set_controls_packed(const int8_t* packed, int numSlots);

// ---- Misc --------------------------------------------------------------------------------
const char* rs_version(void);

#ifdef __cplusplus
}
#endif
