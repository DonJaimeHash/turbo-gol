/**
 * The car bodies the game can draw, by cosmetic id (src/game/cosmetics.ts CarId). Every catalog car
 * has its module here (dune.ts, pampero.ts, ...), exporting its CarBodySpec, or null while its body
 * is still to come: adding a car (docs/cars.md) fills its own module and flips its catalog status
 * to 'available', and this registry never changes (the bodies can be built in parallel). An id
 * with no body (a catalog car still to come, a stale saved pick) draws the default body, so a
 * missing body never breaks a roster.
 */
import { CARPINCHO } from './carpincho';
import { CONDOR } from './condor';
import { DUNE } from './dune';
import { PAMPERO } from './pampero';
import { TERO } from './tero';
import type { CarBodySpec } from './types';

/** The default car, free for everyone: every bot, every online car for now, any unknown id. */
export const DEFAULT_BODY: CarBodySpec = DUNE;

/** Every catalog car's body, in catalog order; null = still to come. */
const MODULES: readonly (CarBodySpec | null)[] = [
  DUNE,
  PAMPERO,
  CARPINCHO,
  CONDOR,
  TERO,
];

/** Every shipped body, in catalog order. */
const BODIES: readonly CarBodySpec[] = MODULES.filter((b): b is CarBodySpec => b !== null);

const byId = new Map<string, CarBodySpec>(BODIES.map((b) => [b.id, b]));

/** The body of car `id`, or the default body when that car has none (yet). */
export function carBody(id: string): CarBodySpec {
  return byId.get(id) ?? DEFAULT_BODY;
}

/** Whether car `id` has a body of its own. */
export function hasCarBody(id: string): boolean {
  return byId.has(id);
}

/** Every registered body (the shipped ones, then any registerCarBody added). */
export function carBodies(): readonly CarBodySpec[] {
  return [...byId.values()];
}

/**
 * Register a body under its id: a body in progress tried in a dev build, or a test's stand-in
 * (tests/car-bodies.test.mjs swaps to one). Shipped bodies go in their own module. An id can be
 * taken once.
 */
export function registerCarBody(spec: CarBodySpec): void {
  const known = byId.get(spec.id);
  if (known !== undefined && known !== spec) throw new Error(`car body '${spec.id}' is already registered`);
  byId.set(spec.id, spec);
}
