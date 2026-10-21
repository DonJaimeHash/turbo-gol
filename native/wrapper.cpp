// wrapper.cpp - implements native/rs_api.h on top of RocketSim 2.2.1 (+ Bullet 3.24) for the
// Emscripten build (see native/build.ps1). One global arena, one static state buffer, one static
// ball-prediction buffer. The layout of both buffers is the CONTRACT in src/sim/types.ts.
//
// Units: everything crossing the C boundary is in uu (1 uu = 1 cm) and sim coordinates (x side,
// y length, z up; blue goal at -y). Bullet units (1 BT = 50 uu) never leave this file.
//
// The field is ours, not RocketSim's built-in soccar layout: rs_set_field_layout (called by the
// bridge with the numbers of src/sim/constants.ts) gives the wall / ceiling planes, the goal line,
// the broadphase bounds, the boost pads and the kickoff / respawn spots; rs_arena_create applies
// them (custom boost pads, planes moved, goal threshold), rs_reset_kickoff deals our kickoff spots,
// rs_add_car and rs_step put new / respawning cars on our respawn spots.
//
// Physics mutators (experimental presets): rs_set_mutators validates a whole layout against hard
// limits (namespace M), then sets it on the arena and on the ball predictor's arena, all or
// nothing. rs_arena_create always starts with RocketSim's stock MutatorConfig.
//
// Exceptions: RocketSim reports fatal errors with RS_ERR_CLOSE, which throws. The module is linked
// without exception catching, so a throw aborts the whole WASM instance. Every entry point below
// therefore validates its inputs and returns an error code / no-ops instead of letting RocketSim
// reach a throw.
//
// Wheel order: RocketSim creates wheels front pair then back pair, and within a pair the FIRST
// wheel has connectionPointOffset.y > 0. The car's local +y is RIGHT (btVehicleRL coordinate
// system: right=1, up=2, forward=0), so RocketSim's order is [FR, FL, BR, BL]. types.ts wants
// C_WHEEL_* in [FL, FR, BL, BR] order, hence WHEEL_SLOT_TO_RS below.

#define _USE_MATH_DEFINES
#include <cmath>
#include <cstdint>
#include <cstring>
#include <algorithm>
#include <map>
#include <random>
#include <vector>

#include "rs_api.h"

// The PATCHED mirror that build.ps1 compiles (native/patch-rocketsim.mjs writes it), never the
// pristine submodule in native/RocketSim: the wrapper must see the same headers as the library
// (patch 2 changes Arena::_cars, patch 3 adds MutatorConfig::carMaxSpeed, which moves every field
// after it).
#include "build/rocketsim/src/RocketSim.h"
#include "build/rocketsim/src/Sim/BallPredTracker/BallPredTracker.h"
#include "build/rocketsim/libsrc/bullet3-3.24/BulletCollision/CollisionDispatch/btInternalEdgeUtility.h"
#include "build/rocketsim/libsrc/bullet3-3.24/BulletCollision/CollisionShapes/btBvhTriangleMeshShape.h"
#include "build/rocketsim/libsrc/bullet3-3.24/BulletCollision/CollisionShapes/btTriangleMesh.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define RS_API EMSCRIPTEN_KEEPALIVE
#else
#define RS_API
#endif

using namespace RocketSim;

// ---- Buffer layout (must match src/sim/types.ts) -----------------------------------------
namespace L {
constexpr int H_TICK_COUNT = 0, H_NUM_CARS = 1, H_GOAL_COUNT = 2, H_LAST_GOAL_TEAM = 3,
              H_BUMP_COUNT = 4, H_LAST_BUMP_BUMPER = 5, H_LAST_BUMP_VICTIM = 6,
              H_LAST_BUMP_IS_DEMO = 7, H_BALL_SCORED = 8;
constexpr int HEADER_SIZE = 16;

constexpr int BALL_OFFSET = 16;
constexpr int B_POS = 0, B_ROT = 3, B_VEL = 12, B_ANG_VEL = 15, B_HIT_VALID = 18, B_HIT_TICK = 19,
              B_HIT_CAR_ID = 20, B_HIT_REL_POS = 21, B_HIT_EXTRA_VEL = 24;
constexpr int BALL_SIZE = 32;

constexpr int MAX_CARS = 8;  // up to 4v4 (3v3 is the largest mode exposed in the UI)
constexpr int CARS_OFFSET = BALL_OFFSET + BALL_SIZE;  // 48
constexpr int CAR_STRIDE = 64;
constexpr int C_ID = 0, C_TEAM = 1, C_POS = 2, C_ROT = 5, C_VEL = 14, C_ANG_VEL = 17, C_BOOST = 20,
              C_IS_ON_GROUND = 21, C_IS_SUPERSONIC = 22, C_IS_JUMPING = 23, C_IS_FLIPPING = 24,
              C_HAS_JUMPED = 25, C_HAS_DOUBLE_JUMPED = 26, C_HAS_FLIPPED = 27, C_IS_DEMOED = 28,
              C_DEMO_RESPAWN_TIMER = 29, C_HANDBRAKE_VAL = 30, C_IS_BOOSTING = 31, C_JUMP_TIME = 32,
              C_FLIP_TIME = 33, C_AIR_TIME = 34, C_IS_AUTO_FLIPPING = 35, C_WHEEL_CONTACT = 36,
              C_WHEEL_SUSPENSION = 40, C_WHEEL_STEER = 44, C_WORLD_CONTACT_NORMAL = 48,
              C_WORLD_CONTACT = 51, C_BALL_HIT_TICK = 52, C_FLIP_REL_TORQUE = 53,
              C_SUPERSONIC_TIME = 56, C_TIME_SINCE_BOOSTED = 57, C_LAST_JUMP_PRESSED = 58;

constexpr int NUM_BOOST_PADS = 32;  // our field: 4 big + 28 small (rs_set_field_layout must match)
constexpr int PADS_OFFSET = CARS_OFFSET + MAX_CARS * CAR_STRIDE;  // 560
constexpr int PAD_STRIDE = 2;
constexpr int P_IS_ACTIVE = 0, P_COOLDOWN = 1;

constexpr int STATE_BUFFER_SIZE = PADS_OFFSET + NUM_BOOST_PADS * PAD_STRIDE;  // 624
constexpr int STATE_BUFFER_FLOATS = 1024;

constexpr int BALL_PRED_TICKS = 720;
constexpr int BALL_PRED_STRIDE = 6;
}  // namespace L
static_assert(L::STATE_BUFFER_SIZE <= L::STATE_BUFFER_FLOATS, "state buffer too small");
static_assert(L::CARS_OFFSET == 48 && L::PADS_OFFSET == 560 && L::STATE_BUFFER_SIZE == 624,
              "layout drifted from types.ts");

// ---- Field layout (rs_set_field_layout; see rs_api.h for the float layout) ------------------
namespace F {
constexpr float VERSION = 1.f;
constexpr int MAX_SPOTS = 8;
struct Spot {
  float x, y, yaw;  // blue team; red is mirrored (x, y negated, yaw + pi)
};
struct Layout {
  bool ready = false;
  float extentX = 0, height = 0, goalLineY = 0;
  Vec boundsMin, boundsMax;
  std::vector<Spot> kickoff, respawn;
  std::vector<BoostPadConfig> pads;
};
// Respawn spots closer than this (uu, 2-D) to another live car are skipped when one is free.
constexpr float RESPAWN_CLEARANCE = 300.f;
// A team with more cars than spots stacks the extra ones this far further upfield per round.
constexpr float EXTRA_SPAWN_OFFSET = 250.f;
}  // namespace F
static F::Layout g_field;

// ---- Physics mutators (rs_set_mutators / rs_get_mutators; layout in rs_api.h) ---------------
namespace M {
constexpr float VERSION = 1.f;
constexpr int COUNT = 19;
constexpr int S_VERSION = 0, S_GRAVITY_Z = 1, S_BALL_MAX_SPEED = 2, S_BALL_HIT_SCALE = 3, S_BALL_MASS = 4,
              S_BALL_RESTITUTION = 5, S_BALL_DRAG = 6, S_CAR_MAX_SPEED = 7, S_BOOST_ACCEL_GROUND = 8,
              S_BOOST_ACCEL_AIR = 9, S_BOOST_USED_PER_SECOND = 10, S_CAR_SPAWN_BOOST = 11,
              S_JUMP_IMMEDIATE_FORCE = 12, S_JUMP_ACCEL = 13, S_UNLIMITED_FLIPS = 14,
              S_UNLIMITED_DOUBLE_JUMPS = 15, S_BUMP_FORCE_SCALE = 16, S_DEMO_MODE = 17, S_RESPAWN_DELAY = 18;
// Hard limits, wider than the UI ranges (src/game/physicsRules.ts keeps those inside these; the
// same numbers are mirrored in src/sim/mutatorLayout.ts for its tests). They keep the sim sane whatever a
// modified client sends: gravity always pulls down, the ball can travel at most 8500 / 120 = 71 uu
// per tick (0.78 of its radius: no tunnelling through the thin goal / corner mesh), a bounce never
// gains energy, the car stays below 2700 uu/s (22.5 uu per tick against a 19.3 uu half hitbox).
struct Limit {
  float lo, hi;
  bool integral;  // exactly an integer in [lo, hi] (version, toggles, demo mode)
};
static const Limit LIMITS[COUNT] = {
    {1.f, 1.f, true},          // version
    {-2000.f, -100.f, false},  // gravityZ
    {1000.f, 8500.f, false},   // ballMaxSpeed
    {0.f, 4.f, false},         // ballHitExtraForceScale
    {10.f, 90.f, false},       // ballMass
    {0.f, 0.95f, false},       // ballWorldRestitution
    {0.f, 0.5f, false},        // ballDrag
    {1500.f, 2700.f, false},   // carMaxSpeed
    {0.f, 3000.f, false},      // boostAccelGround
    {0.f, 3200.f, false},      // boostAccelAir
    {0.f, 100.f, false},       // boostUsedPerSecond
    {0.f, 100.f, false},       // carSpawnBoostAmount
    {0.f, 600.f, false},       // jumpImmediateForce
    {0.f, 3000.f, false},      // jumpAccel
    {0.f, 1.f, true},          // unlimitedFlips
    {0.f, 1.f, true},          // unlimitedDoubleJumps
    {0.f, 5.f, false},         // bumpForceScale
    {0.f, 2.f, true},          // demoMode
    {0.5f, 10.f, false},       // respawnDelay
};
static_assert(sizeof(LIMITS) / sizeof(LIMITS[0]) == COUNT, "one limit per slot");

static bool Valid(const float* data) {
  for (int i = 0; i < COUNT; i++) {
    const float v = data[i];
    const Limit& l = LIMITS[i];
    if (!std::isfinite(v) || v < l.lo || v > l.hi) return false;
    if (l.integral && v != std::floor(v)) return false;
  }
  return true;
}

// Only the listed fields change: carMass (RocketSim 2.2.1's SetMutatorConfig would give every car
// the ball's mass on a carMass change), ballRadius, goalBaseThresholdY and the rest are kept.
static MutatorConfig With(MutatorConfig mc, const float* d) {
  mc.gravity = Vec(mc.gravity.x, mc.gravity.y, d[S_GRAVITY_Z]);
  mc.ballMaxSpeed = d[S_BALL_MAX_SPEED];
  mc.ballHitExtraForceScale = d[S_BALL_HIT_SCALE];
  mc.ballMass = d[S_BALL_MASS];
  mc.ballWorldRestitution = d[S_BALL_RESTITUTION];
  mc.ballDrag = d[S_BALL_DRAG];
  mc.carMaxSpeed = d[S_CAR_MAX_SPEED];  // RocketSim patch 3 (native/patch-rocketsim.mjs)
  mc.boostAccelGround = d[S_BOOST_ACCEL_GROUND];
  mc.boostAccelAir = d[S_BOOST_ACCEL_AIR];
  mc.boostUsedPerSecond = d[S_BOOST_USED_PER_SECOND];
  mc.carSpawnBoostAmount = d[S_CAR_SPAWN_BOOST];
  mc.jumpImmediateForce = d[S_JUMP_IMMEDIATE_FORCE];
  mc.jumpAccel = d[S_JUMP_ACCEL];
  mc.unlimitedFlips = d[S_UNLIMITED_FLIPS] != 0.f;
  mc.unlimitedDoubleJumps = d[S_UNLIMITED_DOUBLE_JUMPS] != 0.f;
  mc.bumpForceScale = d[S_BUMP_FORCE_SCALE];
  mc.demoMode = d[S_DEMO_MODE] == 1.f ? DemoMode::ON_CONTACT : d[S_DEMO_MODE] == 2.f ? DemoMode::DISABLED : DemoMode::NORMAL;
  mc.respawnDelay = d[S_RESPAWN_DELAY];
  return mc;
}

static void Write(const MutatorConfig& mc, float* out) {
  out[S_VERSION] = VERSION;
  out[S_GRAVITY_Z] = mc.gravity.z;
  out[S_BALL_MAX_SPEED] = mc.ballMaxSpeed;
  out[S_BALL_HIT_SCALE] = mc.ballHitExtraForceScale;
  out[S_BALL_MASS] = mc.ballMass;
  out[S_BALL_RESTITUTION] = mc.ballWorldRestitution;
  out[S_BALL_DRAG] = mc.ballDrag;
  out[S_CAR_MAX_SPEED] = mc.carMaxSpeed;
  out[S_BOOST_ACCEL_GROUND] = mc.boostAccelGround;
  out[S_BOOST_ACCEL_AIR] = mc.boostAccelAir;
  out[S_BOOST_USED_PER_SECOND] = mc.boostUsedPerSecond;
  out[S_CAR_SPAWN_BOOST] = mc.carSpawnBoostAmount;
  out[S_JUMP_IMMEDIATE_FORCE] = mc.jumpImmediateForce;
  out[S_JUMP_ACCEL] = mc.jumpAccel;
  out[S_UNLIMITED_FLIPS] = mc.unlimitedFlips ? 1.f : 0.f;
  out[S_UNLIMITED_DOUBLE_JUMPS] = mc.unlimitedDoubleJumps ? 1.f : 0.f;
  out[S_BUMP_FORCE_SCALE] = mc.bumpForceScale;
  out[S_DEMO_MODE] = mc.demoMode == DemoMode::ON_CONTACT ? 1.f : mc.demoMode == DemoMode::DISABLED ? 2.f : 0.f;
  out[S_RESPAWN_DELAY] = mc.respawnDelay;
}

// Arena::SetMutatorConfig, keeping the ball's exact state across the body rebuild a ballMass
// change triggers (RocketSim rebuilds the ball at its spawn origin; Ball::SetState would round-trip
// the position through uu, which is not the identity in float32).
static void SetConfig(Arena* arena, const MutatorConfig& mc) {
  Ball* ball = arena->ball;
  const bool rebuild = mc.ballMass != arena->GetMutatorConfig().ballMass ||
                       mc.ballRadius != arena->GetMutatorConfig().ballRadius;
  const btTransform tf = ball->_rigidBody.getWorldTransform();
  const btVector3 lin = ball->_rigidBody.getLinearVelocity();
  const btVector3 ang = ball->_rigidBody.getAngularVelocity();
  const int activation = ball->_rigidBody.getActivationState();
  const BallState internal = ball->_internalState;
  arena->SetMutatorConfig(mc);
  // Bullet's btDiscreteDynamicsWorld::setGravity only reaches ACTIVE bodies, and Arena::Step puts a
  // ball at rest to sleep (the predictor's arena holds one right after its first prediction, at the
  // kickoff spot): without this its ball would keep the old gravity and no prediction would ever
  // match. The same per-body call Bullet makes when a body is added (bit-identical for stock).
  {
    const btVector3 g = arena->_bulletWorld.getGravity();
    btAlignedObjectArray<btRigidBody*>& bodies = arena->_bulletWorld.getNonStaticRigidBodies();
    for (int i = 0; i < bodies.size(); i++)
      if (!(bodies[i]->getFlags() & BT_DISABLE_WORLD_GRAVITY)) bodies[i]->setGravity(g);
  }
  if (!rebuild) return;
  btRigidBody& rb = ball->_rigidBody;
  rb.setWorldTransform(tf);
  rb.setLinearVelocity(lin);
  rb.setAngularVelocity(ang);
  rb.updateInertiaTensor();
  rb.forceActivationState(activation);
  ball->_internalState = internal;
}
}  // namespace M

// Slot index (FL, FR, BL, BR) -> RocketSim wheel index (FR, FL, BR, BL).
static const int WHEEL_SLOT_TO_RS[4] = {1, 0, 3, 2};

// ---- Globals -----------------------------------------------------------------------------
static float g_state[L::STATE_BUFFER_FLOATS];
static float g_pred[L::BALL_PRED_TICKS * L::BALL_PRED_STRIDE];

static Arena* g_arena = nullptr;
// Slot order = creation order (slot i = g_cars[i]). rs_remove_car ERASES from the vector, so
// every later car moves down one slot; the state buffer is compacted the same way on the next
// rs_sync. Ids never change, so callers must re-resolve id -> slot after a removal.
static std::vector<Car*> g_cars;  // at most L::MAX_CARS entries
static BallPredTracker* g_predTracker = nullptr;
static bool g_unlimitedBoost = false;

static btTriangleMesh* g_triMesh = nullptr;
static btBvhTriangleMeshShape* g_meshShape = nullptr;
static btTriangleInfoMap* g_infoMap = nullptr;

// Event accumulators (written by the arena callbacks, copied into the header by rs_sync).
static constexpr uint64_t NO_TICK = ~0ULL - 1;
static uint32_t g_goalCount = 0;
static int g_lastGoalTeam = 0;
static uint64_t g_lastScoredTick = NO_TICK;  // for de-duplicating the per-tick goal callback
static uint32_t g_bumpCount = 0;
static int g_lastBumper = 0, g_lastVictim = 0, g_lastBumpIsDemo = 0;
static uint64_t g_lastBumpTick = NO_TICK;  // for merging the two directions of a mutual bump

// RocketSim's built-in hitbox presets (identifiers from its API), in the order of our TS CarPreset:
// Standard, Low, Flat, Long, Mid, Tall (src/sim/types.ts).
static const CarConfig* const CAR_PRESETS[6] = {
    &CAR_CONFIG_OCTANE, &CAR_CONFIG_DOMINUS, &CAR_CONFIG_PLANK,
    &CAR_CONFIG_BREAKOUT, &CAR_CONFIG_HYBRID, &CAR_CONFIG_MERC,
};

// ---- Helpers -----------------------------------------------------------------------------
static inline Car* FindCar(int carId) {
  if (carId <= 0) return nullptr;
  for (Car* car : g_cars)
    if (car->id == (uint32_t)carId) return car;
  return nullptr;
}

static inline void PutVec(float* dst, const Vec& v) {
  dst[0] = v.x;
  dst[1] = v.y;
  dst[2] = v.z;
}

static inline void PutRot(float* dst, const RotMat& m) {
  PutVec(dst + 0, m.forward);
  PutVec(dst + 3, m.right);
  PutVec(dst + 6, m.up);
}

static inline float Clamp01x100(float v) { return v < 0 ? 0 : (v > 100 ? 100 : v); }

static void OnGoalScored(Arena* arena, Team team, void*) {
  // RocketSim fires this EVERY tick the ball is inside a net. Count a goal only when the previous
  // tick did not already have the ball in the net (a new goal requires at least one tick outside).
  const uint64_t tick = arena->tickCount;
  const bool continuing = (tick == g_lastScoredTick || tick == g_lastScoredTick + 1);
  g_lastScoredTick = tick;
  if (continuing) return;
  g_goalCount++;
  g_lastGoalTeam = (team == Team::BLUE) ? 0 : 1;
}

static void OnCarBump(Arena* arena, Car* bumper, Car* victim, bool isDemo, void*) {
  // RocketSim tests a car-car contact in both directions and fires this once per direction that
  // qualifies, so a mutual head-on bump arrives twice in the same tick with the pair swapped.
  // Merge those into ONE counted bump. When either direction is a demolition that direction wins,
  // so H_LAST_BUMP_IS_DEMO and the victim are reliable (a demo callback is never followed by a
  // non-demo one for the same contact: the second pass returns early on isDemoed).
  const uint64_t tick = arena->tickCount;
  const bool swappedRepeat =
      tick == g_lastBumpTick && (int)bumper->id == g_lastVictim && (int)victim->id == g_lastBumper;
  if (swappedRepeat) {
    if (isDemo) {
      g_lastBumper = (int)bumper->id;
      g_lastVictim = (int)victim->id;
      g_lastBumpIsDemo = 1;
    }
    return;
  }
  g_lastBumpTick = tick;
  g_bumpCount++;
  g_lastBumper = (int)bumper->id;
  g_lastVictim = (int)victim->id;
  g_lastBumpIsDemo = isDemo ? 1 : 0;
}

static void ResetEventCounters() {
  g_goalCount = 0;
  g_lastGoalTeam = 0;
  g_lastScoredTick = NO_TICK;
  g_bumpCount = 0;
  g_lastBumper = g_lastVictim = g_lastBumpIsDemo = 0;
  g_lastBumpTick = NO_TICK;
}

// ---- Field helpers -------------------------------------------------------------------------
// RocketSim adds infinite planes for the floor (z = 0), the ceiling and the two side walls at its
// own built-in extents. Move the ceiling and side-wall planes to our field (the floor stays). The
// planes are static bodies with an unbounded AABB, so the broadphase needs no update.
static void ApplyFieldPlanes(Arena* arena) {
  for (btRigidBody* rb : arena->_worldCollisionRBs) {
    btCollisionShape* shape = rb->getCollisionShape();
    if (!shape || shape->getShapeType() != STATIC_PLANE_PROXYTYPE) continue;
    const btVector3& n = static_cast<btStaticPlaneShape*>(shape)->getPlaneNormal();
    btVector3 originUU;
    if (n.x() > 0.5f)
      originUU = btVector3(-g_field.extentX, 0, g_field.height * 0.5f);  // wall at -x, facing +x
    else if (n.x() < -0.5f)
      originUU = btVector3(g_field.extentX, 0, g_field.height * 0.5f);  // wall at +x, facing -x
    else if (n.z() < -0.5f)
      originUU = btVector3(0, 0, g_field.height);  // ceiling, facing down
    else
      continue;  // the floor
    btTransform tf = rb->getWorldTransform();
    tf.setOrigin(originUU * UU_TO_BT);
    rb->setWorldTransform(tf);
    rb->setInterpolationWorldTransform(tf);
  }
}

// Fresh car state on a spot (blue frame; red mirrored) at height z, `upfield` uu further toward
// midfield, with `boost`: what a kickoff / respawn gives a car (no jump / flip / demo timers).
static void PlaceOnSpot(Car* car, const F::Spot& spot, float z, float upfield, float boost) {
  const bool blue = car->team == Team::BLUE;
  const float sign = blue ? 1.f : -1.f;
  CarState s = CarState();
  s.pos = Vec(spot.x * sign, (spot.y + upfield) * sign, z);
  s.rotMat = Angle(spot.yaw + (blue ? 0.f : (float)M_PI), 0.f, 0.f).ToRotMat();
  s.boost = boost;  // isOnGround keeps CarState's default (true), as RocketSim's own spawns do
  car->SetState(s);
}

// A car just added (RocketSim spawned it on one of ITS respawn spots with its global random
// engine): the k-th car of its team goes to our respawn spot k (stacked upfield past 4).
static void PlaceNewCar(Car* car) {
  const size_t n = g_field.respawn.size();
  if (n == 0) return;
  int k = 0;
  for (Car* other : g_cars)
    if (other != car && other->team == car->team) k++;
  const F::Spot& spot = g_field.respawn[(size_t)k % n];
  PlaceOnSpot(car, spot, RLConst::CAR_RESPAWN_Z, F::EXTRA_SPAWN_OFFSET * (float)((size_t)k / n),
              g_arena->GetMutatorConfig().carSpawnBoostAmount);
}

// A car that finished its demolition respawn timer during the last tick sits on RocketSim's own
// respawn spot (its rigid body was disabled for that tick, so nothing touched it there): move it
// to one of OUR respawn spots. The choice only depends on state every peer shares (tick count,
// car id, the other cars' positions), never on RocketSim's global random engine, so a rollback
// replay or another instance picks the same spot: a hash of (tick, id) chooses the first spot to
// try, and spots another live car is standing on are skipped while a free one exists.
static void RespawnOnOurSpot(Car* car) {
  const size_t n = g_field.respawn.size();
  if (n == 0) return;
  uint32_t h = (uint32_t)g_arena->tickCount * 2654435761u ^ (car->id * 0x85EBCA6Bu);
  h ^= h >> 15;
  const size_t first = (size_t)(h % (uint32_t)n);
  const float sign = car->team == Team::BLUE ? 1.f : -1.f;
  size_t pick = first;
  for (size_t t = 0; t < n; t++) {
    const size_t idx = (first + t) % n;
    const float x = g_field.respawn[idx].x * sign;
    const float y = g_field.respawn[idx].y * sign;
    bool taken = false;
    for (Car* other : g_cars) {
      if (other == car || other->_internalState.isDemoed) continue;
      const btVector3 p = other->_rigidBody.getWorldTransform().getOrigin() * BT_TO_UU;
      const float dx = p.x() - x, dy = p.y() - y;
      if (dx * dx + dy * dy < F::RESPAWN_CLEARANCE * F::RESPAWN_CLEARANCE) {
        taken = true;
        break;
      }
    }
    if (!taken) {
      pick = idx;
      break;
    }
  }
  PlaceOnSpot(car, g_field.respawn[pick], RLConst::CAR_RESPAWN_Z, 0.f, car->_internalState.boost);
}

static void DestroyMesh() {
  auto& shapes = RocketSim::GetArenaCollisionShapes(GameMode::SOCCAR);
  shapes.clear();
  if (g_meshShape) {
    g_meshShape->m_ownsBvh = true;  // Arena sets this to false; we own it here
    delete g_meshShape;
    g_meshShape = nullptr;
  }
  delete g_infoMap;
  g_infoMap = nullptr;
  delete g_triMesh;
  g_triMesh = nullptr;
}

// ---- Full state save / load (netcode rollback) -------------------------------------------
// Blob layout (little-endian; every multi-field record is a DataStreamOut "group": a uint32 field
// count followed by the raw fields, exactly what RocketSim's own Serialize() functions emit):
//   'R','S','S','1'  uint32 version (STATE_VERSION)  uint32 tickCount  uint8 numCars
//   per car, slot order:
//     uint32 carId  uint8 team
//     CarState::Serialize  = uint8 ballHitInfo.isValid [+ group(5) BALLHITINFO fields]
//                          + group(30) CARSTATE_SERIALIZATION_FIELDS (lastControls included)
//     group(13) anchor     = Vec posBT, Vec velBT (the rigid body's Bullet-unit origin / velocity),
//                            uint64 tickCountSinceUpdate, bool isSupersonic, float airTime,
//                            bool wheelsWithContact[4], float engineForce, float brake,
//                            float steerAngle, float suspensionLength[4], float latFriction[4],
//                            float longFriction[4], float extraPushback[4]
//                            (wheel arrays in RocketSim wheel order)
//     group(8) controls    = CAR_CONTROLS_SERIALIZATION_FIELDS(car->controls): the PENDING controls
//   BallState::Serialize   = group(12) BALLSTATE_SERIALIZATION_FIELDS
//   group(3) ball anchor   = Vec posBT, Vec velBT, uint64 tickCountSinceUpdate
//   uint8 numPads, per pad: BoostPadState::Serialize = group(3)
//
// Why the anchors: RocketSim keeps pos / vel in uu but Bullet integrates in BT units (1 BT = 50 uu)
// and x * UU_TO_BT * BT_TO_UU is NOT the identity in float32, so restoring through Car::SetState
// alone would move every body by up to 1 ulp and a replay would drift from the uninterrupted run.
// The anchors put the Bullet bodies back bit-exactly; the uu fields are then re-derived from them
// with GetState() exactly as the save does, so save(load(blob)) == blob and the hash of a loaded
// state equals the hash the saver computed. The extra CarState members (isSupersonic feeds the
// supersonic-maintain hysteresis, airTime / wheelsWithContact fill the state buffer) are not in
// RocketSim's own field list, hence the anchor group.
//
// The wheel values are REAL physics state, not cosmetics: Car::_PreTickUpdate runs the vehicle's
// calcFrictionImpulses (which reads every wheel's m_engineForce / m_brake / m_latFriction /
// m_longFriction, and the wheel basis built from m_steerAngle) BEFORE Car::_UpdateWheels rewrites
// them from this tick's controls, so each tick drives with the previous tick's values (a
// one-tick input delay), and btVehicleRL::rayCast only rewrites m_extraPushback while the wheel is
// compressed past its threshold, so it sticks until the wheel leaves the ground. Without them a
// car driving on its wheels replays ~0.1 uu/s off after one tick. m_suspensionLength only feeds the
// wheel transform origin and the state buffer (C_WHEEL_SUSPENSION); it is kept so rs_sync() right
// after a load matches the uninterrupted arena exactly.
namespace {
constexpr uint32_t STATE_VERSION = 1;
constexpr uint8_t STATE_MAGIC[4] = {'R', 'S', 'S', '1'};
constexpr int STATE_HEADER_BYTES = 4 + 4 + 4 + 1;
constexpr uint32_t CAR_ANCHOR_COUNT = 13;
constexpr size_t CAR_ANCHOR_BYTES = sizeof(Vec) * 2 + 8 + 1 + 4 + 4 + 4 + 4 + 4 + 16 * 4;  // 125
constexpr uint32_t BALL_ANCHOR_COUNT = 3;
constexpr size_t BALL_ANCHOR_BYTES = sizeof(Vec) * 2 + 8;  // 40
static_assert(sizeof(Vec) == 16 && sizeof(RotMat) == 48 && sizeof(CarControls) == 24,
              "RocketSim struct layout changed: revisit the state blob format");

// Byte size / field count of a DataStreamOut group, from the same field lists Serialize() uses
// (WriteMultipleFromList writes sizeof(field) raw bytes per field).
template <typename... A>
constexpr size_t SizeOfAll(const A&...) { return (sizeof(A) + ... + size_t(0)); }
template <typename... A>
constexpr uint32_t CountAll(const A&...) { return (uint32_t)sizeof...(A); }

struct CarStateProbe : CarState {
  size_t Bytes() const { return SizeOfAll(CARSTATE_SERIALIZATION_FIELDS); }
  uint32_t Count() const { return CountAll(CARSTATE_SERIALIZATION_FIELDS); }
};
struct BallHitProbe : BallHitInfo {
  size_t Bytes() const { return SizeOfAll(BALLHITINFO_SERIALIZATION_FIELDS); }
  uint32_t Count() const { return CountAll(BALLHITINFO_SERIALIZATION_FIELDS); }
};
struct BallStateProbe : BallState {
  size_t Bytes() const { return SizeOfAll(BALLSTATE_SERIALIZATION_FIELDS); }
  uint32_t Count() const { return CountAll(BALLSTATE_SERIALIZATION_FIELDS); }
};
struct PadStateProbe : BoostPadState {
  size_t Bytes() const { return SizeOfAll(BOOSTPAD_SERIALIZATION_FIELDS); }
  uint32_t Count() const { return CountAll(BOOSTPAD_SERIALIZATION_FIELDS); }
};
struct ControlsProbe {
  CarControls c;
  size_t Bytes() const { return SizeOfAll(CAR_CONTROLS_SERIALIZATION_FIELDS(c)); }
  uint32_t Count() const { return CountAll(CAR_CONTROLS_SERIALIZATION_FIELDS(c)); }
};

struct StateLayout {
  size_t hitBytes, carBytes, ballBytes, padBytes, ctlBytes;
  uint32_t hitCount, carCount, ballCount, padCount, ctlCount;
  size_t carRecordMax;  // one car with a valid ball-hit record
  size_t maxBytes;      // MAX_CARS cars
};

static const StateLayout& Layout() {
  static const StateLayout layout = [] {
    StateLayout l{};
    CarStateProbe car;
    BallHitProbe hit;
    BallStateProbe ball;
    PadStateProbe pad;
    ControlsProbe ctl;
    l.hitBytes = hit.Bytes();
    l.hitCount = hit.Count();
    l.carBytes = car.Bytes();
    l.carCount = car.Count();
    l.ballBytes = ball.Bytes();
    l.ballCount = ball.Count();
    l.padBytes = pad.Bytes();
    l.padCount = pad.Count();
    l.ctlBytes = ctl.Bytes();
    l.ctlCount = ctl.Count();
    l.carRecordMax = 4 + 1 + 1 + (4 + l.hitBytes) + (4 + l.carBytes) + (4 + CAR_ANCHOR_BYTES) + (4 + l.ctlBytes);
    l.maxBytes = (size_t)STATE_HEADER_BYTES + (size_t)L::MAX_CARS * l.carRecordMax + (4 + l.ballBytes) +
                 (4 + BALL_ANCHOR_BYTES) + 1 + (size_t)L::NUM_BOOST_PADS * (4 + l.padBytes);
    return l;
  }();
  return layout;
}

// Persistent streams: their vectors are reserved once (rs_arena_create) so rs_save_state,
// rs_state_hash and rs_load_state never reallocate. DataStreamOut::WriteBytes only reserves
// (no-op below capacity) and appends; DataStreamIn::data.assign reuses the capacity.
static DataStreamOut g_stateOut;
static DataStreamIn g_stateIn;
static bool g_stateStreamsReady = false;

static void EnsureStateStreams() {
  if (g_stateStreamsReady) return;
  const size_t cap = Layout().maxBytes;
  g_stateOut.data.reserve(cap);
  g_stateIn.data.reserve(cap);
  g_stateStreamsReady = true;
}

static uint32_t Fnv1a32(const uint8_t* p, size_t n) {
  uint32_t h = 0x811c9dc5u;
  for (size_t i = 0; i < n; i++) {
    h ^= p[i];
    h *= 0x01000193u;
  }
  return h;
}

static void WriteCarRecord(DataStreamOut& out, Car* car) {
  out.Write<uint32_t>(car->id);
  out.Write<uint8_t>(car->team == Team::BLUE ? 0 : 1);
  const CarState s = car->GetState();  // refreshes uu pos / vel / angVel from Bullet
  s.Serialize(out);
  const btRigidBody& rb = car->_rigidBody;
  const Vec posBT = rb.getWorldTransform().getOrigin();
  const Vec velBT = rb.m_linearVelocity;
  const btVehicleRL& veh = car->_bulletVehicle;
  const int nw = veh.getNumWheels();
  // Engine force / brake are written to every wheel together and the steer angle to both front
  // wheels (Car::_UpdateWheels), so one value each is enough.
  const float engineForce = nw > 0 ? veh.m_wheelInfo[0].m_engineForce : 0.f;
  const float brake = nw > 0 ? veh.m_wheelInfo[0].m_brake : 0.f;
  const float steerAngle = nw > 0 ? veh.m_wheelInfo[0].m_steerAngle : 0.f;
  float susp[4] = {0, 0, 0, 0};
  float latF[4] = {0, 0, 0, 0};
  float longF[4] = {0, 0, 0, 0};
  float pushback[4] = {0, 0, 0, 0};
  for (int i = 0; i < 4 && i < nw; i++) {
    const btWheelInfoRL& w = veh.m_wheelInfo[i];
    susp[i] = w.m_raycastInfo.m_suspensionLength;
    latF[i] = w.m_latFriction;
    longF[i] = w.m_longFriction;
    pushback[i] = w.m_extraPushback;
  }
  out.Write<uint32_t>(CAR_ANCHOR_COUNT);
  out.WriteBytes(&posBT, sizeof(Vec));
  out.WriteBytes(&velBT, sizeof(Vec));
  out.Write<uint64_t>(s.tickCountSinceUpdate);
  out.Write<bool>(s.isSupersonic);
  out.Write<float>(s.airTime);
  out.WriteBytes(s.wheelsWithContact, sizeof(s.wheelsWithContact));
  out.Write<float>(engineForce);
  out.Write<float>(brake);
  out.Write<float>(steerAngle);
  out.WriteBytes(susp, sizeof(susp));
  out.WriteBytes(latF, sizeof(latF));
  out.WriteBytes(longF, sizeof(longF));
  out.WriteBytes(pushback, sizeof(pushback));
  out.WriteMultiple(CAR_CONTROLS_SERIALIZATION_FIELDS(car->controls));
}

static void WriteBallRecord(DataStreamOut& out, Ball* ball) {
  BallState b = ball->GetState();
  if (!b.dsInfo.hasDamaged) b.dsInfo.lastDamageTick = 0;  // RocketSim leaves it uninitialised while unused
  b.Serialize(out);
  const Vec posBT = ball->_rigidBody.getWorldTransform().getOrigin();
  const Vec velBT = ball->_rigidBody.getLinearVelocity();
  out.Write<uint32_t>(BALL_ANCHOR_COUNT);
  out.WriteBytes(&posBT, sizeof(Vec));
  out.WriteBytes(&velBT, sizeof(Vec));
  out.Write<uint64_t>(b.tickCountSinceUpdate);
}

// Serialises the arena into g_stateOut (cleared first). Requires g_arena.
static void SerializeArena() {
  EnsureStateStreams();
  DataStreamOut& out = g_stateOut;
  out.data.clear();
  out.pos = 0;
  out.WriteBytes(STATE_MAGIC, 4);
  out.Write<uint32_t>(STATE_VERSION);
  out.Write<uint32_t>((uint32_t)g_arena->tickCount);
  out.Write<uint8_t>((uint8_t)g_cars.size());
  for (Car* car : g_cars) WriteCarRecord(out, car);
  WriteBallRecord(out, g_arena->ball);
  const auto& pads = g_arena->GetBoostPads();
  out.Write<uint8_t>((uint8_t)pads.size());
  for (BoostPad* pad : pads) pad->_internalState.Serialize(out);
}

// Structural validation BEFORE anything is applied: the arena is either fully restored or left
// untouched, and DataStreamIn never sees a bad group count (that would hit RS_ERR_CLOSE, which
// throws and aborts the module without exception support). Returns the rs_load_state code.
struct BlobCursor {
  const uint8_t* p;
  int left;
};
static bool Skip(BlobCursor& c, size_t n) {
  if (c.left < 0 || (size_t)c.left < n) return false;
  c.p += n;
  c.left -= (int)n;
  return true;
}
static bool ReadU8(BlobCursor& c, uint8_t& v) {
  if (c.left < 1) return false;
  v = *c.p;
  return Skip(c, 1);
}
static bool ReadU32(BlobCursor& c, uint32_t& v) {
  if (c.left < 4) return false;
  std::memcpy(&v, c.p, 4);
  return Skip(c, 4);
}
static bool SkipGroup(BlobCursor& c, uint32_t count, size_t bytes) {
  uint32_t have;
  if (!ReadU32(c, have) || have != count) return false;
  return Skip(c, bytes);
}

static int ValidateBlob(const uint8_t* data, int len, uint32_t& tickOut) {
  const StateLayout& lay = Layout();
  BlobCursor c{data, len};
  if (len < 4) return 4;
  if (std::memcmp(data, STATE_MAGIC, 4) != 0) return 2;
  Skip(c, 4);
  uint32_t version;
  if (!ReadU32(c, version)) return 4;
  if (version != STATE_VERSION) return 2;
  if (!ReadU32(c, tickOut)) return 4;
  uint8_t numCars;
  if (!ReadU8(c, numCars)) return 4;
  if (numCars != g_cars.size()) return 3;
  for (size_t i = 0; i < g_cars.size(); i++) {
    uint32_t id;
    uint8_t team, hit;
    if (!ReadU32(c, id) || !ReadU8(c, team)) return 4;
    if (id != g_cars[i]->id || team != (g_cars[i]->team == Team::BLUE ? 0 : 1)) return 3;
    if (!ReadU8(c, hit)) return 4;
    if (hit > 1) return 4;
    if (hit && !SkipGroup(c, lay.hitCount, lay.hitBytes)) return 4;
    if (!SkipGroup(c, lay.carCount, lay.carBytes)) return 4;
    if (!SkipGroup(c, CAR_ANCHOR_COUNT, CAR_ANCHOR_BYTES)) return 4;
    if (!SkipGroup(c, lay.ctlCount, lay.ctlBytes)) return 4;
  }
  if (!SkipGroup(c, lay.ballCount, lay.ballBytes)) return 4;
  if (!SkipGroup(c, BALL_ANCHOR_COUNT, BALL_ANCHOR_BYTES)) return 4;
  uint8_t numPads;
  if (!ReadU8(c, numPads)) return 4;
  if (numPads != g_arena->GetBoostPads().size()) return 2;
  for (int i = 0; i < numPads; i++)
    if (!SkipGroup(c, lay.padCount, lay.padBytes)) return 4;
  if (c.left != 0) return 4;  // len must be exactly what rs_save_state returned
  return 0;
}

static void ApplyCarRecord(DataStreamIn& in, Car* car) {
  CarState s;
  s.Deserialize(in);
  in.Read<uint32_t>();  // anchor group count (validated)
  Vec posBT, velBT;
  in.ReadBytes(&posBT, sizeof(Vec));
  in.ReadBytes(&velBT, sizeof(Vec));
  in.Read(s.tickCountSinceUpdate);
  in.Read(s.isSupersonic);
  in.Read(s.airTime);
  in.ReadBytes(s.wheelsWithContact, sizeof(s.wheelsWithContact));
  float engineForce, brake, steerAngle;
  in.Read(engineForce);
  in.Read(brake);
  in.Read(steerAngle);
  float susp[4], latF[4], longF[4], pushback[4];
  in.ReadBytes(susp, sizeof(susp));
  in.ReadBytes(latF, sizeof(latF));
  in.ReadBytes(longF, sizeof(longF));
  in.ReadBytes(pushback, sizeof(pushback));
  CarControls ctl;
  in.ReadMultiple(CAR_CONTROLS_SERIALIZATION_FIELDS(ctl));

  // What Car::SetState does, with the Bullet-exact origin / velocity instead of uu * UU_TO_BT.
  btRigidBody& rb = car->_rigidBody;
  btTransform& tf = rb.getWorldTransform();
  tf.setOrigin(posBT);
  tf.setBasis(s.rotMat);
  rb.m_linearVelocity = velBT;
  rb.m_angularVelocity = s.angVel;
  rb.updateInertiaTensor();
  car->_velocityImpulseCache = Vec();
  car->_internalState = s;
  (void)car->GetState();  // uu pos / vel / angVel re-derived from Bullet, exactly as the save did
  car->controls = ctl;
  btVehicleRL& veh = car->_bulletVehicle;
  const int nw = veh.getNumWheels();
  for (int i = 0; i < 4 && i < nw; i++) {
    btWheelInfoRL& w = veh.m_wheelInfo[i];
    w.m_engineForce = engineForce;
    w.m_brake = brake;
    w.m_steerAngle = i < 2 ? steerAngle : 0.f;
    w.m_raycastInfo.m_suspensionLength = susp[i];
    w.m_latFriction = latF[i];
    w.m_longFriction = longF[i];
    w.m_extraPushback = pushback[i];
  }
}

static void ApplyBallRecord(DataStreamIn& in, Ball* ball) {
  BallState b;
  b.Deserialize(in);
  in.Read<uint32_t>();  // anchor group count (validated)
  Vec posBT, velBT;
  in.ReadBytes(&posBT, sizeof(Vec));
  in.ReadBytes(&velBT, sizeof(Vec));
  uint64_t sinceUpdate;
  in.Read(sinceUpdate);

  // Ball::SetState with the Bullet-exact origin / velocity.
  btTransform tf;
  tf.setOrigin(posBT);
  tf.setBasis(b.rotMat);
  btRigidBody& rb = ball->_rigidBody;
  rb.setWorldTransform(tf);
  rb.setLinearVelocity(velBT);
  rb.setAngularVelocity(b.angVel);
  rb.updateInertiaTensor();
  if (!velBT.IsZero() || !b.angVel.IsZero()) rb.setActivationState(ACTIVE_TAG);
  ball->_velocityImpulseCache = Vec();
  ball->_internalState = b;
  ball->_internalState.tickCountSinceUpdate = sinceUpdate;
  (void)ball->GetState();
}
}  // namespace

extern "C" {

// ---- Lifecycle ---------------------------------------------------------------------------
RS_API int rs_init_arena_mesh(const float* vertices, int numVertices, const int32_t* triangles,
                              int numTriangles) {
  if (!vertices || !triangles || numVertices <= 0 || numTriangles <= 0) return 1;
  if (numVertices > 4000000 || numTriangles > 4000000) return 1;
  if (g_arena) return 3;  // destroy the arena before replacing the mesh

  // Validate indices first so nothing is half-built on failure.
  for (int t = 0; t < numTriangles * 3; t++) {
    const int32_t idx = triangles[t];
    if (idx < 0 || idx >= numVertices) return 2;
  }

  DestroyMesh();

  g_triMesh = new btTriangleMesh();  // 32-bit indices, 4-component vertices (only mode in this Bullet)
  g_triMesh->preallocateVertices(numVertices);
  g_triMesh->preallocateIndices(numTriangles * 3);
  for (int i = 0; i < numVertices; i++) {
    const float* v = vertices + i * 3;
    g_triMesh->findOrAddVertex(btVector3(v[0] * UU_TO_BT, v[1] * UU_TO_BT, v[2] * UU_TO_BT), false);
  }
  int added = 0;
  for (int t = 0; t < numTriangles; t++) {
    const int32_t a = triangles[t * 3], b = triangles[t * 3 + 1], c = triangles[t * 3 + 2];
    if (a == b || b == c || a == c) continue;  // degenerate, skip
    g_triMesh->addTriangleIndices(a, b, c);
    added++;
  }
  if (added == 0) {
    DestroyMesh();
    return 4;
  }

  // Exactly what RocketSim::InitFromMem does for a loaded collision mesh file.
  g_meshShape = new btBvhTriangleMeshShape(g_triMesh, true);
  g_infoMap = new btTriangleInfoMap();
  btGenerateInternalEdgeInfo(g_meshShape, g_infoMap);
  g_meshShape->setTriangleInfoMap(g_infoMap);

  // Empty map -> stage INITIALIZED without loading any meshes (no-op if already initialised).
  RocketSim::InitFromMem({}, /*silent*/ true);
  RocketSim::GetArenaCollisionShapes(GameMode::SOCCAR).push_back(g_meshShape);
  return 0;
}

RS_API void rs_arena_destroy(void) {
  if (g_predTracker) {
    delete g_predTracker;  // owns its own (car-less) arena
    g_predTracker = nullptr;
  }
  if (g_arena) {
    delete g_arena;  // owns cars, ball and boost pads
    g_arena = nullptr;
  }
  g_cars.clear();
  g_unlimitedBoost = false;
  ResetEventCounters();
  std::memset(g_state, 0, sizeof(g_state));
  std::memset(g_pred, 0, sizeof(g_pred));
}

// Float layout (see rs_api.h): version, extentX, height, goalLineY, boundsMin(3), boundsMax(3),
// nKick, nKick x (x, y, yaw), nResp, nResp x (x, y, yaw), nPads, nPads x (x, y, z, isBig).
RS_API int rs_set_field_layout(const float* data, int count) {
  if (g_arena) return 3;  // destroy the arena first (like the mesh)
  if (!data || count < 11) return 1;
  for (int i = 0; i < count; i++)
    if (!std::isfinite(data[i])) return 1;
  if (data[0] != F::VERSION) return 1;
  F::Layout f;
  f.extentX = data[1];
  f.height = data[2];
  f.goalLineY = data[3];
  f.boundsMin = Vec(data[4], data[5], data[6]);
  f.boundsMax = Vec(data[7], data[8], data[9]);
  if (!(f.extentX > 100.f && f.height > 100.f && f.goalLineY > 100.f)) return 1;
  if (!(f.boundsMin.x < -f.extentX && f.boundsMax.x > f.extentX && f.boundsMin.y < -f.goalLineY &&
        f.boundsMax.y > f.goalLineY && f.boundsMin.z <= 0.f && f.boundsMax.z > f.height))
    return 1;  // the broadphase must enclose the field
  int at = 10;
  auto readSpots = [&](std::vector<F::Spot>& out) -> bool {
    if (at >= count) return false;
    const int n = (int)data[at++];
    if (n < 1 || n > F::MAX_SPOTS || at + n * 3 > count) return false;
    for (int k = 0; k < n; k++, at += 3) {
      const F::Spot s = {data[at], data[at + 1], data[at + 2]};
      if (std::fabs(s.x) >= f.extentX || std::fabs(s.y) >= f.goalLineY) return false;
      out.push_back(s);
    }
    return true;
  };
  if (!readSpots(f.kickoff) || !readSpots(f.respawn)) return 1;
  if (at >= count) return 1;
  const int numPads = (int)data[at++];
  if (numPads != L::NUM_BOOST_PADS) return 2;  // the state buffer has exactly this many pad slots
  if (at + numPads * 4 != count) return 1;
  for (int k = 0; k < numPads; k++, at += 4) {
    BoostPadConfig pad;
    pad.pos = Vec(data[at], data[at + 1], data[at + 2]);
    pad.isBig = data[at + 3] != 0.f;
    f.pads.push_back(pad);
  }
  f.ready = true;
  g_field = f;
  return 0;
}

RS_API int rs_get_boost_pad(int index, float* out4) {
  if (!g_arena || !out4) return 0;
  const auto& pads = g_arena->GetBoostPads();
  if (index < 0 || index >= (int)pads.size()) return 0;
  const BoostPadConfig& c = pads[(size_t)index]->config;
  out4[0] = c.pos.x;
  out4[1] = c.pos.y;
  out4[2] = c.pos.z;
  out4[3] = c.isBig ? 1.f : 0.f;
  return 1;
}

RS_API int rs_arena_create(float tickRate) {
  if (g_arena) rs_arena_destroy();
  if (RocketSim::GetStage() != RocketSimStage::INITIALIZED) return 2;
  if (RocketSim::GetArenaCollisionShapes(GameMode::SOCCAR).empty()) return 2;
  if (!g_field.ready) return 4;  // rs_set_field_layout first
  if (!(tickRate >= 15.f && tickRate <= 120.f)) tickRate = 120.f;  // also rejects NaN

  ArenaConfig config = {};  // defaults: HEAVY mem mode, custom broadphase on, no ball rot
  config.minPos = g_field.boundsMin;
  config.maxPos = g_field.boundsMax;
  config.useCustomBoostPads = true;
  config.customBoostPads = g_field.pads;
  g_arena = Arena::Create(GameMode::SOCCAR, config, tickRate);
  ApplyFieldPlanes(g_arena);
  {
    MutatorConfig mc = g_arena->GetMutatorConfig();
    mc.goalBaseThresholdY = g_field.goalLineY;  // IsBallScored: |ball.y| > goalLineY + ball radius
    g_arena->SetMutatorConfig(mc);
  }
  g_arena->SetGoalScoreCallback(&OnGoalScored, nullptr);
  g_arena->SetCarBumpCallback(&OnCarBump, nullptr);
  ResetEventCounters();
  std::memset(g_state, 0, sizeof(g_state));
  EnsureStateStreams();  // reserve the save / load buffers now, not inside the first snapshot
  return 0;
}

// ---- Cars --------------------------------------------------------------------------------
RS_API int rs_add_car(int team, int preset) {
  if (!g_arena) return 0;
  if ((int)g_cars.size() >= L::MAX_CARS) return 0;  // full: the bridge turns this into a throw
  if (preset < 0 || preset > 5) preset = 0;
  // Team::ORANGE is RocketSim's API name for its second team: Turbogol's Red (team 1).
  Car* car = g_arena->AddCar(team == 0 ? Team::BLUE : Team::ORANGE, *CAR_PRESETS[preset]);
  if (!car) return 0;
  g_cars.push_back(car);
  PlaceNewCar(car);
  return (int)car->id;
}

RS_API int rs_remove_car(int carId) {
  if (!g_arena) return 0;
  Car* car = FindCar(carId);
  if (!car) return 0;
  for (size_t i = 0; i < g_cars.size(); i++) {
    if (g_cars[i] == car) {
      g_cars.erase(g_cars.begin() + (std::ptrdiff_t)i);
      break;
    }
  }
  g_arena->RemoveCar(car->id);  // frees the car
  // Later slots shifted down one: clear the now-unused trailing car slot in the state buffer
  // (rs_sync rewrites every live slot, this one would otherwise keep the removed car's data).
  std::memset(g_state + L::CARS_OFFSET + (int)g_cars.size() * L::CAR_STRIDE, 0,
              sizeof(float) * L::CAR_STRIDE);
  return 1;
}

RS_API void rs_get_car_config(int preset, float* out22) {
  if (!out22) return;
  if (preset < 0 || preset > 5) preset = 0;
  const CarConfig& c = *CAR_PRESETS[preset];
  std::memset(out22, 0, sizeof(float) * 22);
  PutVec(out22 + 0, c.hitboxSize);
  PutVec(out22 + 3, c.hitboxPosOffset);
  out22[6] = c.frontWheels.wheelRadius;
  out22[7] = c.backWheels.wheelRadius;
  out22[8] = c.frontWheels.suspensionRestLength;
  out22[9] = c.backWheels.suspensionRestLength;
  PutVec(out22 + 10, c.frontWheels.connectionPointOffset);
  PutVec(out22 + 13, c.backWheels.connectionPointOffset);
  out22[16] = c.dodgeDeadzone;
}

RS_API void rs_set_controls(int carId, float throttle, float steer, float pitch, float yaw,
                            float roll, int jump, int boost, int handbrake) {
  Car* car = FindCar(carId);
  if (!car) return;
  CarControls& c = car->controls;
  c.throttle = std::isfinite(throttle) ? throttle : 0.f;
  c.steer = std::isfinite(steer) ? steer : 0.f;
  c.pitch = std::isfinite(pitch) ? pitch : 0.f;
  c.yaw = std::isfinite(yaw) ? yaw : 0.f;
  c.roll = std::isfinite(roll) ? roll : 0.f;
  c.jump = jump != 0;
  c.boost = boost != 0;
  c.handbrake = handbrake != 0;
  c.ClampFix();  // RS_MAX_SPEED removes RocketSim's own clamp, so clamp here
}

RS_API void rs_set_car_state(int carId, float x, float y, float z, float yaw, float pitch,
                             float roll, float vx, float vy, float vz, float avx, float avy,
                             float avz) {
  Car* car = FindCar(carId);
  if (!car) return;
  // Fresh state (no leftover jump/flip/demo timers) with boost preserved: a teleport.
  CarState s = CarState();
  s.boost = car->_internalState.boost;
  s.pos = Vec(x, y, z);
  s.rotMat = Angle(yaw, pitch, roll).ToRotMat();
  s.vel = Vec(vx, vy, vz);
  s.angVel = Vec(avx, avy, avz);
  s.isOnGround = true;  // recomputed from the wheel raycasts at the start of the next tick
  car->SetState(s);
}

RS_API void rs_set_car_boost(int carId, float boost) {
  Car* car = FindCar(carId);
  if (!car) return;
  car->_internalState.boost = Clamp01x100(std::isfinite(boost) ? boost : 0.f);
}

RS_API void rs_set_car_dodge_deadzone(int carId, float deadzone) {
  Car* car = FindCar(carId);
  if (!car) return;
  if (!std::isfinite(deadzone)) return;
  car->config.dodgeDeadzone = deadzone;
}

RS_API void rs_demolish_car(int carId) {
  Car* car = FindCar(carId);
  if (!car || !g_arena) return;
  car->Demolish(g_arena->GetMutatorConfig().respawnDelay);
}

// ---- Ball --------------------------------------------------------------------------------
RS_API void rs_set_ball_state(float x, float y, float z, float vx, float vy, float vz, float avx,
                              float avy, float avz) {
  if (!g_arena) return;
  BallState s = g_arena->ball->GetState();
  s.pos = Vec(x, y, z);
  s.vel = Vec(vx, vy, vz);
  s.angVel = Vec(avx, avy, avz);
  // Arena::Step puts a ball with EXACTLY zero velocity to sleep (kickoff optimisation), so a ball
  // placed at rest in mid-air would float forever. Nudge it so gravity takes over next tick.
  if (s.vel.IsZero() && s.angVel.IsZero() && z > RLConst::BALL_REST_Z + 1.f) s.vel.z = -1e-3f;
  g_arena->ball->SetState(s);
  // A ball placed OUTSIDE a net forgets the last goal, so its next entry counts as a new goal. A
  // ball placed inside a net keeps the de-dup state: the game pins the ball in the net every tick
  // during the goal pause (rs_set_ball_state at the scoring position), which must read as the
  // same goal continuing, not as 120 new goals per second.
  if (!g_arena->IsBallScored()) g_lastScoredTick = NO_TICK;
}

// ---- Simulation --------------------------------------------------------------------------
// One tick at a time (Arena::Step(n) is the same loop): before each tick note which cars are
// demolished, after it move every car whose respawn timer ran out onto our respawn spots.
static bool g_wasDemoed[L::MAX_CARS];

RS_API void rs_step(int n) {
  if (!g_arena || n <= 0) return;
  const size_t numCars = g_cars.size();
  for (int i = 0; i < n; i++) {
    bool anyDemoed = false;
    for (size_t k = 0; k < numCars; k++) {
      Car* car = g_cars[k];
      if (g_unlimitedBoost) car->_internalState.boost = 100.f;
      g_wasDemoed[k] = car->_internalState.isDemoed;
      anyDemoed = anyDemoed || g_wasDemoed[k];
    }
    g_arena->Step(1);
    if (anyDemoed)
      for (size_t k = 0; k < numCars; k++)
        if (g_wasDemoed[k] && !g_cars[k]->_internalState.isDemoed) RespawnOnOurSpot(g_cars[k]);
  }
  if (g_unlimitedBoost)
    for (Car* car : g_cars) car->_internalState.boost = 100.f;
}

RS_API void rs_sync(void) {
  if (!g_arena) return;
  float* S = g_state;

  // Header
  S[L::H_TICK_COUNT] = (float)g_arena->tickCount;
  S[L::H_NUM_CARS] = (float)g_cars.size();
  S[L::H_GOAL_COUNT] = (float)g_goalCount;
  S[L::H_LAST_GOAL_TEAM] = (float)g_lastGoalTeam;
  S[L::H_BUMP_COUNT] = (float)g_bumpCount;
  S[L::H_LAST_BUMP_BUMPER] = (float)g_lastBumper;
  S[L::H_LAST_BUMP_VICTIM] = (float)g_lastVictim;
  S[L::H_LAST_BUMP_IS_DEMO] = (float)g_lastBumpIsDemo;
  S[L::H_BALL_SCORED] = g_arena->IsBallScored() ? 1.f : 0.f;

  // Ball
  {
    float* B = S + L::BALL_OFFSET;
    const BallState bs = g_arena->ball->GetState();
    PutVec(B + L::B_POS, bs.pos);
    PutRot(B + L::B_ROT, bs.rotMat);
    PutVec(B + L::B_VEL, bs.vel);
    PutVec(B + L::B_ANG_VEL, bs.angVel);

    // RocketSim 2.2.1 keeps ball-hit info per car only; the ball's "last hit" is the most recent
    // valid one across all cars.
    const Car* lastHitter = nullptr;
    for (const Car* car : g_cars) {
      const BallHitInfo& h = car->_internalState.ballHitInfo;
      if (!h.isValid) continue;
      if (!lastHitter || h.tickCountWhenHit > lastHitter->_internalState.ballHitInfo.tickCountWhenHit)
        lastHitter = car;
    }
    if (lastHitter) {
      const BallHitInfo& h = lastHitter->_internalState.ballHitInfo;
      B[L::B_HIT_VALID] = 1.f;
      B[L::B_HIT_TICK] = (float)h.tickCountWhenHit;
      B[L::B_HIT_CAR_ID] = (float)lastHitter->id;
      PutVec(B + L::B_HIT_REL_POS, h.relativePosOnBall);
      PutVec(B + L::B_HIT_EXTRA_VEL, h.extraHitVel);
    } else {
      B[L::B_HIT_VALID] = 0.f;
      B[L::B_HIT_TICK] = -1.f;
      B[L::B_HIT_CAR_ID] = 0.f;
      PutVec(B + L::B_HIT_REL_POS, Vec());
      PutVec(B + L::B_HIT_EXTRA_VEL, Vec());
    }
  }

  // Cars
  for (size_t slot = 0; slot < g_cars.size() && slot < (size_t)L::MAX_CARS; slot++) {
    Car* car = g_cars[slot];
    float* C = S + L::CARS_OFFSET + (int)slot * L::CAR_STRIDE;
    (void)car->GetState();  // refreshes pos/vel/angVel inside _internalState
    const CarState& s = car->_internalState;

    C[L::C_ID] = (float)car->id;
    C[L::C_TEAM] = (car->team == Team::BLUE) ? 0.f : 1.f;
    PutVec(C + L::C_POS, s.pos);
    PutRot(C + L::C_ROT, s.rotMat);
    PutVec(C + L::C_VEL, s.vel);
    PutVec(C + L::C_ANG_VEL, s.angVel);
    C[L::C_BOOST] = s.boost;
    C[L::C_IS_ON_GROUND] = s.isOnGround ? 1.f : 0.f;
    C[L::C_IS_SUPERSONIC] = s.isSupersonic ? 1.f : 0.f;
    C[L::C_IS_JUMPING] = s.isJumping ? 1.f : 0.f;
    C[L::C_IS_FLIPPING] = s.isFlipping ? 1.f : 0.f;
    C[L::C_HAS_JUMPED] = s.hasJumped ? 1.f : 0.f;
    C[L::C_HAS_DOUBLE_JUMPED] = s.hasDoubleJumped ? 1.f : 0.f;
    C[L::C_HAS_FLIPPED] = s.hasFlipped ? 1.f : 0.f;
    C[L::C_IS_DEMOED] = s.isDemoed ? 1.f : 0.f;
    C[L::C_DEMO_RESPAWN_TIMER] = s.demoRespawnTimer;
    C[L::C_HANDBRAKE_VAL] = s.handbrakeVal;
    C[L::C_IS_BOOSTING] = s.isBoosting ? 1.f : 0.f;
    C[L::C_JUMP_TIME] = s.jumpTime;
    C[L::C_FLIP_TIME] = s.flipTime;
    C[L::C_AIR_TIME] = s.airTime;
    C[L::C_IS_AUTO_FLIPPING] = s.isAutoFlipping ? 1.f : 0.f;

    const int numWheels = car->_bulletVehicle.getNumWheels();
    for (int k = 0; k < 4; k++) {
      const int rs = WHEEL_SLOT_TO_RS[k];
      if (rs < numWheels) {
        const btWheelInfoRL& w = car->_bulletVehicle.m_wheelInfo[rs];
        C[L::C_WHEEL_CONTACT + k] = s.wheelsWithContact[rs] ? 1.f : 0.f;
        // Wheel centre (car local) = connectionPointOffset + (0, 0, -suspensionLength).
        C[L::C_WHEEL_SUSPENSION + k] = w.m_raycastInfo.m_suspensionLength * BT_TO_UU;
        C[L::C_WHEEL_STEER + k] = w.m_steerAngle;
      } else {
        C[L::C_WHEEL_CONTACT + k] = 0.f;
        C[L::C_WHEEL_SUSPENSION + k] = 0.f;
        C[L::C_WHEEL_STEER + k] = 0.f;
      }
    }

    PutVec(C + L::C_WORLD_CONTACT_NORMAL, s.worldContact.contactNormal);
    C[L::C_WORLD_CONTACT] = s.worldContact.hasContact ? 1.f : 0.f;
    C[L::C_BALL_HIT_TICK] = s.ballHitInfo.isValid ? (float)s.ballHitInfo.tickCountWhenHit : -1.f;
    PutVec(C + L::C_FLIP_REL_TORQUE, s.flipRelTorque);
    C[L::C_SUPERSONIC_TIME] = s.supersonicTime;
    C[L::C_TIME_SINCE_BOOSTED] = s.timeSinceBoosted;
    C[L::C_LAST_JUMP_PRESSED] = s.lastControls.jump ? 1.f : 0.f;
  }

  // Boost pads (RocketSim order: 6 big, then 28 small)
  {
    const auto& pads = g_arena->GetBoostPads();
    float* P = S + L::PADS_OFFSET;
    const int n = (int)pads.size() < L::NUM_BOOST_PADS ? (int)pads.size() : L::NUM_BOOST_PADS;
    for (int i = 0; i < n; i++) {
      const BoostPadState& ps = pads[i]->_internalState;
      P[i * L::PAD_STRIDE + L::P_IS_ACTIVE] = ps.isActive ? 1.f : 0.f;
      P[i * L::PAD_STRIDE + L::P_COOLDOWN] = ps.cooldown;
    }
  }
}

RS_API float* rs_state_ptr(void) { return g_state; }

// Kickoff on OUR spots (RocketSim's ResetToRandomKickoff only knows its built-in ones). The seed
// shuffles the spot list once; the k-th car of each team in CREATION order (g_cars) takes spot
// order[k], so blue car k and red car k stand on mirrored spots and a seed alone fixes the
// line-up. (RocketSim's own deal follows the iteration order of its unordered_set<Car*>; with the
// default pointer hash that was heap-address order, which made the same seeded 3v3 run differ
// between processes, see README.) A team with more cars than kickoff spots puts the rest on the
// respawn spots. Then, like RocketSim's reset: kickoff boost, ball at rest on the centre spot,
// every pad active.
RS_API void rs_reset_kickoff(int seed) {
  if (!g_arena) return;
  const unsigned seedValue = seed >= 0 ? (unsigned)seed : (unsigned)Math::GetRandEngine()();
  const size_t nk = g_field.kickoff.size();
  const size_t nr = g_field.respawn.size();
  size_t order[F::MAX_SPOTS];
  for (size_t k = 0; k < nk; k++) order[k] = k;
  std::default_random_engine engine(seedValue);
  std::shuffle(order, order + nk, engine);
  const float boost = g_arena->GetMutatorConfig().carSpawnBoostAmount;
  size_t perTeam[2] = {0, 0};
  for (Car* car : g_cars) {
    const size_t k = perTeam[car->team == Team::BLUE ? 0 : 1]++;
    if (k < nk) {
      PlaceOnSpot(car, g_field.kickoff[order[k]], RLConst::CAR_SPAWN_REST_Z, 0.f, boost);
    } else if (nr > 0) {
      const size_t extra = k - nk;
      PlaceOnSpot(car, g_field.respawn[extra % nr], RLConst::CAR_SPAWN_REST_Z,
                  F::EXTRA_SPAWN_OFFSET * (float)(extra / nr), boost);
    }
  }
  g_arena->ball->SetState(BallState());
  for (BoostPad* pad : g_arena->GetBoostPads()) pad->SetState(BoostPadState());
  // A seeded kickoff also pins RocketSim's global engine. Nothing in a match depends on it any
  // more (respawns use our deterministic spot choice), but RocketSim still draws from it when a
  // car respawns, so pinning keeps a seeded run's engine state reproducible too. seed -1 (the
  // game) leaves it time-seeded.
  if (seed >= 0) Math::GetRandEngine().seed((unsigned)seed * 7919u + 1u);
  g_lastScoredTick = NO_TICK;
}

RS_API int rs_is_ball_scored(void) {
  if (!g_arena) return 0;
  return g_arena->IsBallScored() ? 1 : 0;
}

// ---- Ball prediction ---------------------------------------------------------------------
// predData[0] is the current state, predData[t] the state after t ticks. The contract wants
// entry t = state after t+1 ticks, so the tracker predicts one tick more than BALL_PRED_TICKS.
static void FillBallPred(void) {
  const std::vector<BallState>& pred = g_predTracker->predData;
  const int available = (int)pred.size() - 1;
  for (int t = 0; t < L::BALL_PRED_TICKS; t++) {
    float* E = g_pred + t * L::BALL_PRED_STRIDE;
    const int src = (t + 1 <= available) ? t + 1 : available;
    if (src < 0) break;
    const BallState& b = pred[(size_t)src];
    PutVec(E + 0, b.pos);
    PutVec(E + 3, b.vel);
  }
}

// The tracker builds its own car-less arena from our ArenaConfig (bounds, pads) and predicts once
// in its constructor, before that arena has our planes and our mutators (it starts with stock
// ones): move the planes, copy the arena's MutatorConfig, then predict again. With stock physics
// the copy changes nothing the ball feels (same gravity, drag, bounce, mass; the goal threshold is
// never read by a car-less, callback-less arena). Without it a preset arena would never Match()
// its prediction and every update would be a full 720-tick re-simulation.
static void CreatePredTracker(void) {
  g_predTracker = new BallPredTracker(g_arena, (size_t)L::BALL_PRED_TICKS + 1);
  ApplyFieldPlanes(g_predTracker->ballPredArena);
  M::SetConfig(g_predTracker->ballPredArena, g_arena->GetMutatorConfig());
  g_predTracker->ForceUpdateAllPred(g_arena->ball->GetState());
  g_predTracker->lastUpdateTickCount = (int)g_arena->tickCount;
}

RS_API void rs_ball_pred_update(void) {
  if (!g_arena) return;
  if (!g_predTracker) {
    CreatePredTracker();  // a full prediction
  } else {
    g_predTracker->UpdatePredFromArena(g_arena);  // incremental unless the ball was disturbed
  }
  FillBallPred();
}

RS_API void rs_ball_pred_force(void) {
  if (!g_arena) return;
  if (!g_predTracker) {
    CreatePredTracker();  // a full prediction already
  } else {
    g_predTracker->ForceUpdateAllPred(g_arena->ball->GetState());
    g_predTracker->lastUpdateTickCount = (int)g_arena->tickCount;
  }
  FillBallPred();
}

RS_API float* rs_ball_pred_ptr(void) { return g_pred; }

// ---- Mutators ----------------------------------------------------------------------------
RS_API void rs_set_demo_mode(int demoMode) {
  if (!g_arena) return;
  MutatorConfig mc = g_arena->GetMutatorConfig();
  switch (demoMode) {
    case 1: mc.demoMode = DemoMode::ON_CONTACT; break;
    case 2: mc.demoMode = DemoMode::DISABLED; break;
    default: mc.demoMode = DemoMode::NORMAL; break;
  }
  g_arena->SetMutatorConfig(mc);
}

RS_API void rs_set_unlimited_boost(int enabled) {
  g_unlimitedBoost = enabled != 0;
  if (g_unlimitedBoost)
    for (Car* car : g_cars) car->_internalState.boost = 100.f;
}

RS_API int rs_set_mutators(const float* data, int count) {
  if (!g_arena) return 2;
  if (!data || count != M::COUNT || data[M::S_VERSION] != M::VERSION) return 1;
  if (!M::Valid(data)) return 1;
  const MutatorConfig mc = M::With(g_arena->GetMutatorConfig(), data);
  if (mc.ballMass != g_arena->GetMutatorConfig().ballMass && !g_cars.empty()) return 3;
  M::SetConfig(g_arena, mc);
  if (g_predTracker) {
    // The predictor follows at once: same config, then a full prediction from the current ball.
    M::SetConfig(g_predTracker->ballPredArena, mc);
    g_predTracker->ForceUpdateAllPred(g_arena->ball->GetState());
    g_predTracker->lastUpdateTickCount = (int)g_arena->tickCount;
    FillBallPred();
  }
  return 0;
}

RS_API int rs_get_mutators(float* out, int cap) {
  if (!g_arena || !out || cap < M::COUNT) return 0;
  M::Write(g_arena->GetMutatorConfig(), out);
  return M::COUNT;
}

// ---- Full state save / load (netcode rollback) -------------------------------------------
RS_API int rs_save_state(uint8_t* out, int cap) {
  if (!g_arena || !out || cap < 0) return -1;
  SerializeArena();
  const size_t n = g_stateOut.data.size();
  if (n > (size_t)cap) return -1;
  std::memcpy(out, g_stateOut.data.data(), n);
  return (int)n;
}

RS_API int rs_load_state(const uint8_t* data, int len) {
  if (!g_arena) return 1;
  if (!data || len < 0) return 4;
  uint32_t tick = 0;
  const int rc = ValidateBlob(data, len, tick);
  if (rc != 0) return rc;
  EnsureStateStreams();
  DataStreamIn& in = g_stateIn;
  in.data.assign(data, data + len);  // capacity reserved up front: no reallocation
  in.pos = STATE_HEADER_BYTES;
  for (Car* car : g_cars) {
    in.Read<uint32_t>();  // car id (validated)
    in.Read<uint8_t>();   // team (validated)
    ApplyCarRecord(in, car);
  }
  ApplyBallRecord(in, g_arena->ball);
  in.Read<uint8_t>();  // numPads (validated)
  for (BoostPad* pad : g_arena->GetBoostPads()) {
    BoostPadState ps = pad->GetState();
    ps.Deserialize(in);
    ps.curLockedCar = nullptr;  // per-tick lock, re-established by the next _CheckCollide
    pad->SetState(ps);
  }
  g_arena->tickCount = tick;
  // Event de-duplication: a loaded ball already inside a net is the SAME goal continuing (the next
  // tick's callback must not count it again); anywhere else the next entry is a new goal. The
  // goal / bump COUNTERS stay monotonic, so replaying a tick that scored re-fires the event.
  g_lastScoredTick = g_arena->IsBallScored() ? (uint64_t)tick - 1 : NO_TICK;
  g_lastBumpTick = NO_TICK;
  return 0;
}

RS_API int rs_state_size_max(void) {
  // Bound for the CURRENT roster (every car with a valid ball-hit record); without an arena the
  // roster is empty. Sizes grow with cars, so re-query after adding cars (the bridge does).
  const StateLayout& lay = Layout();
  const size_t numCars = g_arena ? g_cars.size() : 0;
  return (int)((size_t)STATE_HEADER_BYTES + numCars * lay.carRecordMax + (4 + lay.ballBytes) +
               (4 + BALL_ANCHOR_BYTES) + 1 + (size_t)L::NUM_BOOST_PADS * (4 + lay.padBytes));
}

RS_API uint32_t rs_state_hash(void) {
  if (!g_arena) return 0;
  SerializeArena();
  return Fnv1a32(g_stateOut.data.data(), g_stateOut.data.size());
}

RS_API void rs_set_controls_packed(const int8_t* packed, int numSlots) {
  if (!packed || numSlots <= 0) return;
  const int n = numSlots < (int)g_cars.size() ? numSlots : (int)g_cars.size();
  for (int slot = 0; slot < n; slot++) {
    const int8_t* p = packed + slot * 6;
    CarControls& c = g_cars[(size_t)slot]->controls;
    // Divide in double and round to float, which is exactly what the JS side's `p / 127` produces
    // when it crosses the f32 boundary of rs_set_controls: both paths yield identical controls.
    c.throttle = (float)(p[0] / 127.0);
    c.steer = (float)(p[1] / 127.0);
    c.pitch = (float)(p[2] / 127.0);
    c.yaw = (float)(p[3] / 127.0);
    c.roll = (float)(p[4] / 127.0);
    c.jump = (p[5] & 1) != 0;
    c.boost = (p[5] & 2) != 0;
    c.handbrake = (p[5] & 4) != 0;
    c.ClampFix();  // -128 / 127 is just below -1
  }
}

// ---- Misc --------------------------------------------------------------------------------
RS_API const char* rs_version(void) { return RS_VERSION; }

}  // extern "C"
