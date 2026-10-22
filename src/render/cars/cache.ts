/**
 * Shared car geometry, reference-counted like the shared material (Car.ts acquireCarMaterial):
 * one body geometry per (body, team, detail, hitbox) and one wheel geometry per (wheel style,
 * team, detail), so identical cars draw the same buffers (a 3v3 of one body builds 2 bodies, not
 * 6) and a roster change re-uses what is there. A geometry is disposed when the last CarView
 * releases it; Game.rebuildCarViews builds the new views before disposing the old ones, so a
 * rebuild with the same cars builds nothing. Super low's wheels stay out of it: their meshes
 * instance through vertex attributes, which three disposes along with a geometry, so each view
 * keeps its own wheels until it goes (Car.ts CarView.ownWheels).
 */
import type * as THREE from 'three/webgpu';
import type { CarConfigInfo, Team } from '../../sim/types';
import { buildBody } from './kit';
import type { CarBodySpec, CarDetail, WheelStyle } from './types';
import { buildWheel } from './wheels';

/** A geometry handed out by the cache and the key to release it with. */
export interface SharedGeometry {
  readonly geometry: THREE.BufferGeometry;
  readonly key: string;
}

interface Entry {
  readonly geometry: THREE.BufferGeometry;
  refs: number;
}

const bodies = new Map<string, Entry>();
const wheels = new Map<string, Entry>();

/** The hitbox numbers a body is built from (every car is Standard today; a preset would differ). */
function configKey(cfg: CarConfigInfo): string {
  return [...cfg.hitboxSize, ...cfg.hitboxOffset, cfg.frontWheelRadius, cfg.backWheelRadius, ...cfg.frontWheelOffset, ...cfg.backWheelOffset].join(',');
}

function acquire(map: Map<string, Entry>, key: string, build: () => THREE.BufferGeometry): SharedGeometry {
  let entry = map.get(key);
  if (entry === undefined) {
    entry = { geometry: build(), refs: 0 };
    map.set(key, entry);
  }
  entry.refs++;
  return { geometry: entry.geometry, key };
}

function release(map: Map<string, Entry>, key: string): void {
  const entry = map.get(key);
  if (entry === undefined) return;
  entry.refs--;
  if (entry.refs <= 0) {
    entry.geometry.dispose();
    map.delete(key);
  }
}

/** The body geometry of `spec` for this hitbox, team and detail (built on first use). */
export function acquireBodyGeometry(spec: CarBodySpec, cfg: CarConfigInfo, team: Team, detail: CarDetail): SharedGeometry {
  return acquire(bodies, `${spec.id}|${team}|${detail}|${configKey(cfg)}`, () => buildBody(spec, cfg, team, detail));
}

/** Drops one reference to a body geometry; the last one disposes it. A stray key is a no-op. */
export function releaseBodyGeometry(key: string): void {
  release(bodies, key);
}

/** The unit wheel of `style` for this team (its hub) and detail (built on first use). */
export function acquireWheelGeometry(style: WheelStyle, team: Team, detail: CarDetail): SharedGeometry {
  return acquire(wheels, `${style.id}|${team}|${detail}`, () => buildWheel(style, detail, team));
}

/** Drops one reference to a wheel geometry; the last one disposes it. A stray key is a no-op. */
export function releaseWheelGeometry(key: string): void {
  release(wheels, key);
}

/** Geometries alive and their references (tests, the console). */
export function geometryCacheStats(): { bodies: number; wheels: number; refs: number } {
  let refs = 0;
  for (const e of bodies.values()) refs += e.refs;
  for (const e of wheels.values()) refs += e.refs;
  return { bodies: bodies.size, wheels: wheels.size, refs };
}
