/**
 * RocketSimBridge: loads the RocketSim WebAssembly module (src/sim/wasm/rocketsim.js, built by
 * native/build.ps1) and exposes it as a SimStateView plus a small command API.
 *
 * This is the ONLY module that touches WASM memory. Everyone else reads `buf` through the offsets
 * in ./types. No allocations happen per tick: `buf` and `ballPred` are typed-array views over the
 * module's static buffers and are only re-created when the WASM memory grows (the ArrayBuffer is
 * replaced on growth, which detaches old views).
 *
 * Pure TS, no DOM, no node APIs: runs in the browser (Vite), in node (tests/sim.test.mjs) and in
 * workerd (server/src/wasm.ts loads it with a precompiled module, see `load()`).
 *
 * Full-state save / load (rollback netcode): saveState() / loadState() / stateHash() go through
 * ONE persistent scratch buffer of MAX_STATE_BYTES in wasm memory, setControlsPacked() through a
 * persistent MAX_CARS * 6 int8 scratch; nothing is allocated per call.
 */
import createRocketSim from './wasm/rocketsim.js';
import type { RocketSimModule, RocketSimModuleOptions } from './wasm/rocketsim.js';
import {
  BALL_OFFSET,
  BALL_PRED_STRIDE,
  BALL_PRED_TICKS,
  B_VEL,
  CARS_OFFSET,
  CAR_STRIDE,
  C_BALL_HIT_TICK,
  C_ID,
  C_TEAM,
  C_VEL,
  CarPreset,
  H_BUMP_COUNT,
  H_GOAL_COUNT,
  H_LAST_BUMP_BUMPER,
  H_LAST_BUMP_IS_DEMO,
  H_LAST_BUMP_VICTIM,
  H_LAST_GOAL_TEAM,
  H_NUM_CARS,
  H_TICK_COUNT,
  MAX_CARS,
  MAX_STATE_BYTES,
  PACKED_INPUT_BYTES,
  STATE_BUFFER_FLOATS,
  TICK_RATE,
  Team,
} from './types';
import type { CarConfigInfo, CarControls, SimEvents, SimStateView } from './types';
import {
  ARENA,
  BOOST_PADS_BIG,
  BOOST_PADS_SMALL,
  BROADPHASE_MAX,
  BROADPHASE_MIN,
  KICKOFF_SPAWNS,
  RESPAWN_SPOTS,
} from './constants';

export type Vec3Like = readonly [number, number, number];

/** rs_set_field_layout format version (see native/rs_api.h). */
const FIELD_LAYOUT_VERSION = 1;

/**
 * Our field as the float array rs_set_field_layout takes (native/rs_api.h): walls / ceiling, goal
 * line, broadphase bounds, kickoff and respawn spots (blue team), boost pads in state-buffer
 * order. Built from constants.ts, so the physics and every reader of constants.ts agree.
 */
export function fieldLayoutData(): Float32Array {
  const out: number[] = [FIELD_LAYOUT_VERSION, ARENA.extentX, ARENA.height, ARENA.goalScoreThresholdY];
  out.push(...BROADPHASE_MIN, ...BROADPHASE_MAX);
  out.push(KICKOFF_SPAWNS.length);
  for (const s of KICKOFF_SPAWNS) out.push(s[0], s[1], s[2]);
  out.push(RESPAWN_SPOTS.length);
  for (const s of RESPAWN_SPOTS) out.push(s[0], s[1], s[2]);
  out.push(BOOST_PADS_BIG.length + BOOST_PADS_SMALL.length);
  for (const p of BOOST_PADS_BIG) out.push(p[0], p[1], p[2], 1);
  for (const p of BOOST_PADS_SMALL) out.push(p[0], p[1], p[2], 0);
  return Float32Array.from(out);
}

/** A boost pad as the wasm sees it (rs_get_boost_pad). */
export interface BoostPadInfo {
  pos: [number, number, number];
  isBig: boolean;
}

const ZERO3: Vec3Like = [0, 0, 0];
const CAR_CONFIG_FLOATS = 22;

/** How `RocketSim.load()` obtains the wasm. Without options the glue locates rocketsim.wasm itself. */
export interface RocketSimLoadOptions {
  /**
   * A precompiled module (workerd: `import mod from './rocketsim.wasm'`, or node:
   * `WebAssembly.compile(bytes)`): instantiated with `new WebAssembly.Instance(mod, imports)` through
   * the glue's `instantiateWasm` hook, which runs BEFORE any fetch / instantiateStreaming / file read.
   */
  wasmModule?: WebAssembly.Module;
  /** The .wasm bytes: the glue compiles them (WebAssembly.instantiate(bytes, imports)). Ignored with wasmModule. */
  wasmBinary?: ArrayBuffer;
}

/** Arena collision mesh in uu / sim coordinates, normals pointing into the arena. */
export interface ArenaMeshData {
  vertices: Float32Array;
  indices: Int32Array | Uint32Array;
}

function readCString(mod: RocketSimModule, ptr: number): string {
  const heap = new Uint8Array(mod.wasmMemory.buffer);
  let end = ptr;
  while (heap[end] !== 0) end++;
  let s = '';
  for (let i = ptr; i < end; i++) s += String.fromCharCode(heap[i]);
  return s;
}

export class RocketSim implements SimStateView {
  /** Set handlers here; sync() fires them when the corresponding counters change. */
  readonly events: SimEvents = {};
  /** RocketSim version string (e.g. "2.2.1"). */
  readonly version: string;

  /** State buffer view (STATE_BUFFER_FLOATS floats). Refreshed by sync(). */
  buf: Float32Array;
  /** Ball prediction view (BALL_PRED_TICKS * BALL_PRED_STRIDE floats). Refreshed by updateBallPrediction(). */
  ballPred: Float32Array;
  /** tickCount at the last updateBallPrediction(): entry t of ballPred = ball state at tick predTick + t + 1. */
  predTick = 0;

  private readonly mod: RocketSimModule;
  private readonly memory: WebAssembly.Memory;
  private readonly statePtr: number;
  private readonly predPtr: number;
  /**
   * Persistent wasm scratch for state blobs and its view (re-created on memory growth). Sized
   * MAX_STATE_BYTES up front, which covers every roster up to MAX_CARS (8 cars need 4191 B); it is
   * re-allocated (once, not per call) only if a blob ever needs more.
   */
  private stateScratchPtr: number;
  private stateScratchCap: number;
  private stateScratch: Uint8Array;
  /** Persistent wasm scratch for packed controls (MAX_CARS * PACKED_INPUT_BYTES int8) and its view. */
  private readonly packedPtr: number;
  private packedScratch: Int8Array;
  private configScratchPtr = 0;
  private hasArena = false;
  private meshReady = false;

  // Previous event counters (for edge detection in sync()). The per-slot arrays follow MAX_CARS
  // from types.ts (the wrapper mirrors the same constant), one entry per state-buffer car slot.
  private prevGoalCount = 0;
  private prevBumpCount = 0;
  private readonly prevHitTick = new Float32Array(MAX_CARS);
  private readonly prevHitCarId = new Float32Array(MAX_CARS);

  private constructor(mod: RocketSimModule) {
    this.mod = mod;
    this.memory = mod.wasmMemory;
    this.statePtr = mod._rs_state_ptr();
    this.predPtr = mod._rs_ball_pred_ptr();
    // Allocate the scratches BEFORE creating any view (malloc may grow / replace the memory buffer).
    this.stateScratchCap = MAX_STATE_BYTES;
    this.stateScratchPtr = mod._malloc(MAX_STATE_BYTES);
    this.packedPtr = mod._malloc(MAX_CARS * PACKED_INPUT_BYTES);
    const b = this.memory.buffer;
    this.buf = new Float32Array(b, this.statePtr, STATE_BUFFER_FLOATS);
    this.ballPred = new Float32Array(b, this.predPtr, BALL_PRED_TICKS * BALL_PRED_STRIDE);
    this.stateScratch = new Uint8Array(b, this.stateScratchPtr, MAX_STATE_BYTES);
    this.packedScratch = new Int8Array(b, this.packedPtr, MAX_CARS * PACKED_INPUT_BYTES);
    this.version = readCString(mod, mod._rs_version());
    this.prevHitTick.fill(-1);
  }

  /**
   * Instantiate the WASM module. Every call creates an independent instance (own memory, own
   * global arena). Without options the Emscripten glue locates rocketsim.wasm next to itself
   * (Vite asset in the browser, file read in node). With `wasmModule` the glue's `instantiateWasm`
   * hook short-circuits all of that and does `new WebAssembly.Instance(module, imports)`, the only
   * instantiation path workerd allows (the glue checks the hook before findWasmBinary / fetch /
   * instantiateStreaming, verified against the generated rocketsim.js).
   */
  static async load(opts: RocketSimLoadOptions = {}): Promise<RocketSim> {
    const moduleArg: RocketSimModuleOptions = {};
    const wasmModule = opts.wasmModule;
    if (wasmModule) {
      moduleArg.instantiateWasm = (imports, onSuccess) => {
        const instance = new WebAssembly.Instance(wasmModule, imports);
        onSuccess(instance);
        return instance.exports;
      };
    } else if (opts.wasmBinary) {
      moduleArg.wasmBinary = opts.wasmBinary;
    }
    const mod = await createRocketSim(moduleArg);
    return new RocketSim(mod);
  }

  // ---- SimStateView ----------------------------------------------------------------------
  get tickCount(): number {
    return this.buf[H_TICK_COUNT];
  }
  get numCars(): number {
    return this.buf[H_NUM_CARS];
  }
  carOffset(slot: number): number {
    return CARS_OFFSET + slot * CAR_STRIDE;
  }
  /**
   * Slot of a car id, or -1. Slots are creation order and COMPACT: removeCar() shifts every later
   * car down one slot (the wrapper erases from its car vector), so a slot resolved before a removal
   * may now point at another car. Ids never change; re-resolve after removeCar(). This reads the
   * buffer, which removeCar() / addCar() refresh, so it is always current.
   */
  slotOf(carId: number): number {
    const n = this.buf[H_NUM_CARS];
    for (let i = 0; i < n; i++) {
      if (this.buf[CARS_OFFSET + i * CAR_STRIDE + C_ID] === carId) return i;
    }
    return -1;
  }
  /** Car id in a slot (0 when the slot is empty / out of range). */
  carIdOf(slot: number): number {
    if (slot < 0 || slot >= this.buf[H_NUM_CARS]) return 0;
    return this.buf[CARS_OFFSET + slot * CAR_STRIDE + C_ID];
  }
  /** Team of the car in a slot (Blue for an empty / out of range slot). */
  teamOf(slot: number): Team {
    if (slot < 0 || slot >= this.buf[H_NUM_CARS]) return Team.Blue;
    return this.buf[CARS_OFFSET + slot * CAR_STRIDE + C_TEAM] === 1 ? Team.Red : Team.Blue;
  }
  /**
   * Writes the slots of every car on `team` (ascending) into `out` and returns how many were
   * written (at most out.length; size it MAX_CARS to always get them all). Allocation-free.
   */
  slotsOfTeam(team: Team, out: Int32Array): number {
    const n = this.buf[H_NUM_CARS];
    const want = team === Team.Red ? 1 : 0;
    let k = 0;
    for (let slot = 0; slot < n && k < out.length; slot++) {
      if (this.buf[CARS_OFFSET + slot * CAR_STRIDE + C_TEAM] === want) out[k++] = slot;
    }
    return k;
  }

  // ---- Lifecycle -------------------------------------------------------------------------
  /**
   * Upload the arena collision mesh (uu, sim coords) and our field layout (fieldLayoutData():
   * walls, goal line, pads, kickoff / respawn spots from constants.ts), and initialise RocketSim.
   * Call before createArena().
   */
  initArena(mesh: ArenaMeshData): void {
    const nv = Math.floor(mesh.vertices.length / 3);
    const nt = Math.floor(mesh.indices.length / 3);
    if (nv <= 0 || nt <= 0) throw new Error('RocketSim.initArena: empty mesh');
    if (this.hasArena) this.destroyArena();
    const mod = this.mod;
    const field = fieldLayoutData();
    const vPtr = mod._malloc(nv * 3 * 4);
    const tPtr = mod._malloc(nt * 3 * 4);
    const fPtr = mod._malloc(field.length * 4);
    try {
      // Create the views AFTER every malloc (each may grow/replace the memory buffer).
      new Float32Array(this.memory.buffer, vPtr, nv * 3).set(mesh.vertices.subarray(0, nv * 3));
      new Int32Array(this.memory.buffer, tPtr, nt * 3).set(mesh.indices.subarray(0, nt * 3));
      new Float32Array(this.memory.buffer, fPtr, field.length).set(field);
      const rc = mod._rs_init_arena_mesh(vPtr, nv, tPtr, nt);
      if (rc !== 0) throw new Error(`rs_init_arena_mesh failed with code ${rc} (1 bad args, 2 bad index, 3 arena exists, 4 no triangles)`);
      const rf = mod._rs_set_field_layout(fPtr, field.length);
      if (rf !== 0) throw new Error(`rs_set_field_layout failed with code ${rf} (1 bad data, 2 pad count != NUM_BOOST_PADS, 3 arena exists)`);
    } finally {
      mod._free(fPtr);
      mod._free(tPtr);
      mod._free(vPtr);
    }
    this.meshReady = true;
    this.ensureViews();
  }

  /** Create (or re-create) the arena. */
  createArena(tickRate: number = TICK_RATE): void {
    if (!this.meshReady) throw new Error('RocketSim.createArena: call initArena(mesh) first');
    const rc = this.mod._rs_arena_create(tickRate);
    if (rc !== 0) throw new Error(`rs_arena_create failed with code ${rc} (2 no mesh, 4 no field layout)`);
    this.hasArena = true;
    this.prevGoalCount = 0;
    this.prevBumpCount = 0;
    this.prevHitTick.fill(-1);
    this.prevHitCarId.fill(0);
    this.mod._rs_sync();
    this.ensureViews();
    // Warm up the ball predictor now (it lazily builds a second, car-less arena) so the first
    // in-game updateBallPrediction() does not stall a frame.
    this.updateBallPrediction();
  }

  destroyArena(): void {
    this.mod._rs_arena_destroy();
    this.hasArena = false;
    this.ensureViews();
  }

  // ---- Cars ------------------------------------------------------------------------------
  /**
   * Adds a car and returns its id (> 0). It takes slot `numCars` (slot order = creation order).
   * Throws without an arena or when MAX_CARS cars already exist (the wrapper refuses, it never
   * overflows the buffer).
   */
  addCar(team: Team, preset: CarPreset = CarPreset.Standard): number {
    if (!this.hasArena) throw new Error('RocketSim.addCar: no arena (call createArena() first)');
    if (this.buf[H_NUM_CARS] >= MAX_CARS) throw new Error(`RocketSim.addCar: MAX_CARS (${MAX_CARS}) reached`);
    const id = this.mod._rs_add_car(team, preset);
    if (id <= 0) throw new Error('rs_add_car failed');
    this.mod._rs_sync();
    this.ensureViews();
    return id;
  }

  /**
   * Removes a car. Slots COMPACT: every car created after it moves down one slot (its id is
   * unchanged), the trailing slot is zeroed and `buf` is refreshed before this returns, so
   * slotOf() / carIdOf() / teamOf() / slotsOfTeam() are immediately consistent. Callers that
   * cache slots must re-resolve them (Game keeps ids and calls slotOf()). Unknown ids are a no-op.
   */
  removeCar(carId: number): void {
    this.mod._rs_remove_car(carId);
    this.mod._rs_sync();
    this.ensureViews();
  }

  getCarConfig(preset: CarPreset): CarConfigInfo {
    if (this.configScratchPtr === 0) this.configScratchPtr = this.mod._malloc(CAR_CONFIG_FLOATS * 4);
    this.mod._rs_get_car_config(preset, this.configScratchPtr);
    const f = new Float32Array(this.memory.buffer, this.configScratchPtr, CAR_CONFIG_FLOATS);
    const cfg: CarConfigInfo = {
      hitboxSize: [f[0], f[1], f[2]],
      hitboxOffset: [f[3], f[4], f[5]],
      frontWheelRadius: f[6],
      backWheelRadius: f[7],
      frontSuspensionRest: f[8],
      backSuspensionRest: f[9],
      frontWheelOffset: [f[10], f[11], f[12]],
      backWheelOffset: [f[13], f[14], f[15]],
      dodgeDeadzone: f[16],
    };
    this.ensureViews();
    return cfg;
  }

  setControls(carId: number, c: CarControls): void {
    this.mod._rs_set_controls(
      carId,
      c.throttle,
      c.steer,
      c.pitch,
      c.yaw,
      c.roll,
      c.jump ? 1 : 0,
      c.boost ? 1 : 0,
      c.handbrake ? 1 : 0,
    );
  }

  /** Teleport a car (uu, radians). Boost is preserved, jump/flip state is reset. */
  setCarState(
    carId: number,
    pos: Vec3Like,
    yawPitchRoll: Vec3Like,
    vel: Vec3Like = ZERO3,
    angVel: Vec3Like = ZERO3,
  ): void {
    this.mod._rs_set_car_state(
      carId,
      pos[0],
      pos[1],
      pos[2],
      yawPitchRoll[0],
      yawPitchRoll[1],
      yawPitchRoll[2],
      vel[0],
      vel[1],
      vel[2],
      angVel[0],
      angVel[1],
      angVel[2],
    );
  }

  setCarBoost(carId: number, amount: number): void {
    this.mod._rs_set_car_boost(carId, amount);
  }

  setCarDodgeDeadzone(carId: number, deadzone: number): void {
    this.mod._rs_set_car_dodge_deadzone(carId, deadzone);
  }

  demolishCar(carId: number): void {
    this.mod._rs_demolish_car(carId);
  }

  // ---- Ball ------------------------------------------------------------------------------
  setBallState(pos: Vec3Like, vel: Vec3Like = ZERO3, angVel: Vec3Like = ZERO3): void {
    this.mod._rs_set_ball_state(pos[0], pos[1], pos[2], vel[0], vel[1], vel[2], angVel[0], angVel[1], angVel[2]);
  }

  // ---- Mutators --------------------------------------------------------------------------
  /** 0 normal (supersonic bumps demolish), 1 any contact demolishes, 2 demos disabled. */
  setDemoMode(mode: 0 | 1 | 2): void {
    this.mod._rs_set_demo_mode(mode);
  }

  setUnlimitedBoost(on: boolean): void {
    this.mod._rs_set_unlimited_boost(on ? 1 : 0);
  }

  // ---- Simulation ------------------------------------------------------------------------
  /** Advance n ticks (1/tickRate each). Does not refresh `buf`; call sync(). */
  step(n = 1): void {
    this.mod._rs_step(n);
  }

  /** Refresh `buf` from the arena and fire events for anything that changed since the last sync. */
  sync(): void {
    this.mod._rs_sync();
    this.ensureViews();
    const buf = this.buf;
    const ev = this.events;

    const goals = buf[H_GOAL_COUNT];
    if (goals !== this.prevGoalCount) {
      this.prevGoalCount = goals;
      if (ev.onGoal) ev.onGoal(buf[H_LAST_GOAL_TEAM] === 1 ? Team.Red : Team.Blue);
    }

    const bumps = buf[H_BUMP_COUNT];
    if (bumps !== this.prevBumpCount) {
      this.prevBumpCount = bumps;
      if (ev.onBump) ev.onBump(buf[H_LAST_BUMP_BUMPER], buf[H_LAST_BUMP_VICTIM], buf[H_LAST_BUMP_IS_DEMO] !== 0);
    }

    const n = buf[H_NUM_CARS];
    for (let slot = 0; slot < MAX_CARS; slot++) {
      if (slot >= n) {
        this.prevHitTick[slot] = -1;
        this.prevHitCarId[slot] = 0;
        continue;
      }
      const off = CARS_OFFSET + slot * CAR_STRIDE;
      const id = buf[off + C_ID];
      const tick = buf[off + C_BALL_HIT_TICK];
      const sameCar = this.prevHitCarId[slot] === id;
      if (sameCar && tick >= 0 && tick !== this.prevHitTick[slot] && ev.onBallHit) {
        // Relative car<->ball speed right after the touch (proxy for impact strength).
        const bv = BALL_OFFSET + B_VEL;
        const cv = off + C_VEL;
        const dx = buf[bv] - buf[cv];
        const dy = buf[bv + 1] - buf[cv + 1];
        const dz = buf[bv + 2] - buf[cv + 2];
        ev.onBallHit(id, Math.sqrt(dx * dx + dy * dy + dz * dz));
      }
      this.prevHitTick[slot] = tick;
      this.prevHitCarId[slot] = id;
    }
  }

  /**
   * Refresh `buf` from the arena WITHOUT firing events: the event baseline (goal / bump counters,
   * per-car last ball-hit tick) is moved to the current state, so the next sync() only reports
   * what happens after this call. For re-simulated ticks (rollback), whose events already fired
   * when they were first simulated.
   */
  syncQuiet(): void {
    this.mod._rs_sync();
    this.ensureViews();
    this.resetEventBaseline();
  }

  /** Copy the current state buffer into dst (dst.length >= STATE_BUFFER_FLOATS). */
  snapshotInto(dst: Float32Array): void {
    dst.set(this.buf);
  }

  // ---- Full state save / load (rollback netcode) ---------------------------------------------
  /**
   * Serialise the complete dynamic state (rs_save_state: tick count, every car incl. its pending
   * controls, the ball, the pads; Bullet-exact) into `out` and return the byte length. The blob is
   * opaque: same wasm on both ends, restore it with loadState() on the same roster. Allocation-free
   * when `out.length >= MAX_STATE_BYTES` (the whole scratch is copied; bytes past the returned
   * length are unspecified); a shorter `out` gets exactly the blob through a subarray view.
   * Throws without an arena or when `out` is smaller than the blob.
   */
  saveState(out: Uint8Array): number {
    this.ensureStateScratch(this.mod._rs_state_size_max());
    const n = this.mod._rs_save_state(this.stateScratchPtr, this.stateScratchCap);
    this.ensureViews();
    if (n < 0) throw new Error('rs_save_state failed (no arena)');
    if (out.length >= this.stateScratchCap) out.set(this.stateScratch);
    else if (out.length >= n) out.set(this.stateScratch.subarray(0, n));
    else throw new Error(`RocketSim.saveState: out (${out.length} bytes) is smaller than the blob (${n})`);
    return n;
  }

  /**
   * Restore a blob produced by saveState() on the SAME roster (same car ids in the same slots; a
   * fresh arena with the cars added in the same order qualifies, ids restart at 1 per arena).
   * `len` must be exactly the length saveState returned. Throws with the rs_load_state code in the
   * message: 1 no arena, 2 bad magic / version, 3 roster mismatch, 4 truncated / corrupt; a failed
   * load leaves the arena untouched. On success `buf` is refreshed WITHOUT firing events: the
   * event baseline (per-car last ball-hit tick) is reset to the loaded state so the next sync()
   * only reports what happens after the load, and the ball-prediction age is reset (call
   * updateBallPrediction() before reading ballPred again). The goal / bump counters in the header
   * are monotonic wrapper counters, not sim state: replaying a tick that scored fires onGoal again.
   */
  loadState(blob: Uint8Array, len: number = blob.length): void {
    if (len < 0 || len > blob.length) {
      throw new Error(`RocketSim.loadState: bad length ${len} (blob ${blob.length})`);
    }
    this.ensureStateScratch(len);
    this.ensureViews();
    if (len === blob.length) this.stateScratch.set(blob);
    else this.stateScratch.set(blob.subarray(0, len));
    const rc = this.mod._rs_load_state(this.stateScratchPtr, len);
    if (rc !== 0) {
      throw new Error(`rs_load_state failed with code ${rc} (1 no arena, 2 bad magic/version, 3 roster mismatch, 4 truncated)`);
    }
    this.mod._rs_sync();
    this.ensureViews();
    this.resetEventBaseline();
    this.predTick = this.buf[H_TICK_COUNT];
  }

  /** FNV-1a 32 (unsigned) of the bytes saveState() would produce now; 0 without an arena. */
  stateHash(): number {
    return this.mod._rs_state_hash() >>> 0;
  }

  /**
   * Upper bound of a saveState() blob for the CURRENT roster (grows with cars: query it after the
   * roster is complete): 13 + numCars * 448 + 594 bytes, so every roster up to MAX_CARS fits in
   * MAX_STATE_BYTES (3v3: 3295, 8 cars: 4191).
   */
  stateSizeMax(): number {
    return this.mod._rs_state_size_max();
  }

  /**
   * Set the controls of the first `numSlots` cars (slot order) from packed int8 controls, 6 per slot
   * (see types.ts packControls). Slots beyond the roster are ignored by the wrapper. Equivalent to
   * setControls() with the unpacked floats (the wrapper rounds `v / 127` exactly like the f32
   * boundary does), so a host and a client fed the same packed bytes compute the same tick.
   */
  setControlsPacked(packed: Int8Array, numSlots: number): void {
    const n = numSlots * PACKED_INPUT_BYTES;
    if (numSlots < 0 || numSlots > MAX_CARS || n > packed.length) {
      throw new Error(`RocketSim.setControlsPacked: ${numSlots} slots do not fit (packed ${packed.length} bytes)`);
    }
    this.ensureViews();
    const dst = this.packedScratch;
    for (let i = 0; i < n; i++) dst[i] = packed[i];
    this.mod._rs_set_controls_packed(this.packedPtr, numSlots);
  }

  /**
   * Reset to a kickoff (seed -1 = random): the seed shuffles our kickoff spots (constants.ts
   * KICKOFF_SPAWNS) and the k-th car of each team in creation order takes spot k, red mirrored;
   * ball at rest on the centre spot, pads active, kickoff boost.
   */
  resetKickoff(seed = -1): void {
    this.mod._rs_reset_kickoff(seed);
  }

  /** Pad `index` (state-buffer order) as the wasm simulates it, or null (no arena / bad index). Not for hot paths. */
  boostPadInfo(index: number): BoostPadInfo | null {
    if (this.configScratchPtr === 0) this.configScratchPtr = this.mod._malloc(CAR_CONFIG_FLOATS * 4);
    const ok = this.mod._rs_get_boost_pad(index, this.configScratchPtr) !== 0;
    this.ensureViews();
    if (!ok) return null;
    const f = new Float32Array(this.memory.buffer, this.configScratchPtr, 4);
    return { pos: [f[0], f[1], f[2]], isBig: f[3] !== 0 };
  }

  isBallScored(): boolean {
    return this.mod._rs_is_ball_scored() !== 0;
  }

  /**
   * Refresh `ballPred` from the arena's current ball state: entry t = ball state at tick
   * `predTick + t + 1` where predTick = tickCount now (call after sync() so the two agree).
   * Incremental (one ball tick) while the ball is undisturbed; a full 720-tick re-prediction
   * (1-5 ms) after a touch.
   */
  updateBallPrediction(): void {
    this.mod._rs_ball_pred_update();
    this.ensureViews();
    this.predTick = this.buf[H_TICK_COUNT];
  }

  /**
   * Like updateBallPrediction() but always a full re-prediction from the current ball state (1-5
   * ms). The incremental tracker reuses its data while the real ball stays within a tolerance
   * (0.8 uu / 0.4 uu/s) of the predicted one, so two arenas in the same state but with different
   * update histories (one of them loaded a state) hold slightly different predictions and their
   * bots can decide differently; lockstep peers call this at agreed ticks to be identical again.
   */
  forceBallPrediction(): void {
    this.mod._rs_ball_pred_force();
    this.ensureViews();
    this.predTick = this.buf[H_TICK_COUNT];
  }

  // ---- Internals -------------------------------------------------------------------------
  /** Re-create the typed-array views if the WASM memory buffer was replaced by growth. */
  private ensureViews(): void {
    const b = this.memory.buffer;
    if (this.buf.buffer !== b) {
      this.buf = new Float32Array(b, this.statePtr, STATE_BUFFER_FLOATS);
      this.ballPred = new Float32Array(b, this.predPtr, BALL_PRED_TICKS * BALL_PRED_STRIDE);
      this.stateScratch = new Uint8Array(b, this.stateScratchPtr, this.stateScratchCap);
      this.packedScratch = new Int8Array(b, this.packedPtr, MAX_CARS * PACKED_INPUT_BYTES);
    }
  }

  /** Grow the state scratch (never per call: only when a roster needs more than it ever had). */
  private ensureStateScratch(need: number): void {
    if (need <= this.stateScratchCap) return;
    const cap = Math.max(need, this.stateScratchCap * 2);
    const ptr = this.mod._malloc(cap);
    this.mod._free(this.stateScratchPtr);
    this.stateScratchPtr = ptr;
    this.stateScratchCap = cap;
    this.stateScratch = new Uint8Array(this.memory.buffer, ptr, cap);
    this.ensureViews();
  }

  /**
   * Make the event edge-detection state match `buf` (after loadState): the per-slot last ball-hit
   * ticks may have gone BACKWARDS, so take them as the new baseline instead of reporting them. The
   * goal / bump counters are monotonic and unaffected by a load, but syncing them is free.
   */
  private resetEventBaseline(): void {
    const buf = this.buf;
    const n = buf[H_NUM_CARS];
    for (let slot = 0; slot < MAX_CARS; slot++) {
      if (slot >= n) {
        this.prevHitTick[slot] = -1;
        this.prevHitCarId[slot] = 0;
        continue;
      }
      const off = CARS_OFFSET + slot * CAR_STRIDE;
      this.prevHitTick[slot] = buf[off + C_BALL_HIT_TICK];
      this.prevHitCarId[slot] = buf[off + C_ID];
    }
    this.prevGoalCount = buf[H_GOAL_COUNT];
    this.prevBumpCount = buf[H_BUMP_COUNT];
  }
}
