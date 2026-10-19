/**
 * RocketSim arenas inside Node.js: the node-side twin of server/src/wasm.ts (which needs workerd's
 * `import x from './rocketsim.wasm'`). The wasm is read and compiled ONCE per process; every match
 * (and every verification) gets its own instance, so its own memory and its own global arena.
 *
 * Where the wasm comes from, first hit wins:
 *   1. $TGN_WASM
 *   2. rocketsim.wasm next to the running bundle (a release: releases/<v>/rocketsim.wasm)
 *   3. the repo copy (src/sim/wasm/rocketsim.wasm) when running from source
 * Its SHA-256 is the build identity every placement and verification compares.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { RocketSim } from '../../src/sim/RocketSimBridge';
import { buildArenaMesh } from '../../src/sim/arenaMesh';
import type { MeshData } from '../../src/sim/arenaMesh';
import { CarPreset, TICK_RATE } from '../../src/sim/types';
import type { RosterEntry } from '../../server/src/roomHost';
import { sha256Hex } from './edcrypto';

export interface LoadedWasm {
  module: WebAssembly.Module;
  sha256: string;
  path: string;
  bytes: number;
}

let loaded: Promise<LoadedWasm> | null = null;
let meshCache: MeshData | null = null;

export function wasmCandidates(): string[] {
  const out: string[] = [];
  const env = process.env.TGN_WASM;
  if (env) out.push(env);
  out.push(fileURLToPath(new URL('./rocketsim.wasm', import.meta.url)));
  out.push(fileURLToPath(new URL('../../src/sim/wasm/rocketsim.wasm', import.meta.url)));
  return out;
}

/** Read + compile + hash the wasm once per process. */
export function loadWasm(): Promise<LoadedWasm> {
  if (!loaded) {
    loaded = (async () => {
      let lastErr: unknown = null;
      for (const path of wasmCandidates()) {
        let bytes: Uint8Array;
        try {
          bytes = await readFile(path);
        } catch (e) {
          lastErr = e;
          continue;
        }
        const module = await WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>);
        return { module, sha256: await sha256Hex(bytes), path, bytes: bytes.length };
      }
      throw new Error(`rocketsim.wasm not found (${String(lastErr)})`);
    })();
    loaded.catch(() => {
      loaded = null;
    });
  }
  return loaded;
}

/** The analytic arena collision mesh (built once per process). */
export function arenaMesh(): MeshData {
  if (!meshCache) meshCache = buildArenaMesh().physics;
  return meshCache;
}

export interface NodeArena {
  sim: RocketSim;
  /** Car id per roster slot (creation order == sim slot order). */
  carIds: number[];
}

/** Same steps as server/src/wasm.ts createHostArena: instance, mesh, 120 Hz arena, one car per slot, kickoff. */
export async function createNodeArena(roster: readonly RosterEntry[], kickoffSeed: number): Promise<NodeArena> {
  const wasm = await loadWasm();
  const sim = await RocketSim.load({ wasmModule: wasm.module });
  sim.initArena(arenaMesh());
  sim.createArena(TICK_RATE);
  const carIds: number[] = [];
  for (const e of roster) carIds.push(sim.addCar(e.team, CarPreset.Standard));
  sim.resetKickoff(kickoffSeed);
  sim.sync();
  return { sim, carIds };
}

/** SimFactory for shared/verify.ts. */
export async function nodeSimFactory(roster: readonly RosterEntry[], kickoffSeed: number): Promise<RocketSim> {
  return (await createNodeArena(roster, kickoffSeed)).sim;
}
