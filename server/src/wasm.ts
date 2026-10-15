/**
 * Loads the SAME RocketSim wasm the browser runs (src/sim/wasm/rocketsim.wasm) inside workerd.
 * workerd forbids WebAssembly.instantiate(bytes) but allows instantiating an imported module, so
 * the bundle imports the .wasm as a WebAssembly.Module (wrangler rule CompiledWasm) and the
 * bridge's `instantiateWasm` hook does `new WebAssembly.Instance(module, imports)`.
 *
 * Every call makes a fresh wasm instance (own memory, own global arena): one per MatchDO.
 */
import wasmModule from '../../src/sim/wasm/rocketsim.wasm';
import { RocketSim } from '../../src/sim/RocketSimBridge';
import { buildArenaMesh } from '../../src/sim/arenaMesh';
import type { MeshData } from '../../src/sim/arenaMesh';
import { CarPreset, TICK_RATE } from '../../src/sim/types';
import type { RosterEntry } from './roomHost';

let meshCache: MeshData | null = null;

/**
 * workerd (with Node.js compat, on by default for this compatibility date) exposes
 * process.versions.node, so the Emscripten glue believes it runs in node and calls
 * createRequire(import.meta.url), which is undefined in a bundle. The glue skips its node branch
 * when process.type === 'renderer' (Electron's check); nothing else in this Worker reads it.
 */
function disableNodeDetection(): void {
  const g = globalThis as { process?: { type?: string } };
  if (g.process && g.process.type !== 'renderer') {
    try {
      g.process.type = 'renderer';
    } catch {
      /* read-only: the glue will fail loudly below */
    }
  }
}

/** The analytic arena collision mesh (built once per isolate). */
export function arenaMesh(): MeshData {
  if (!meshCache) meshCache = buildArenaMesh().physics;
  return meshCache;
}

export interface HostArena {
  sim: RocketSim;
  /** Car id per roster slot (creation order == sim slot order). */
  carIds: number[];
}

/** Instantiate the wasm, upload the arena, create it at 120 Hz and add one car per roster slot. */
export async function createHostArena(roster: readonly RosterEntry[], kickoffSeed: number): Promise<HostArena> {
  disableNodeDetection();
  const sim = await RocketSim.load({ wasmModule });
  sim.initArena(arenaMesh());
  sim.createArena(TICK_RATE);
  const carIds: number[] = [];
  for (const e of roster) carIds.push(sim.addCar(e.team, CarPreset.Standard));
  sim.resetKickoff(kickoffSeed);
  sim.sync();
  return { sim, carIds };
}
