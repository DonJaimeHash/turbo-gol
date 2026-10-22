/**
 * The car bodies the game can draw, by cosmetic id (src/game/cosmetics.ts CarId). Adding a car
 * (docs/cars.md): its module next to dune.ts, one line in BODIES; the catalog entry's status then
 * moves from 'soon' to 'available'. An id with no body here (a catalog car still to come, a stale
 * saved pick) draws the default body, so a missing body never breaks a roster.
 */
import { DUNE } from './dune';
import type { CarBodySpec } from './types';

/** The default car, free for everyone: every bot, every online car for now, any unknown id. */
export const DEFAULT_BODY: CarBodySpec = DUNE;

/** Every shipped body, in catalog order. */
const BODIES: readonly CarBodySpec[] = [DUNE];

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
 * (tests/car-bodies.test.mjs swaps to one). Shipped bodies go in BODIES. An id can be taken once.
 */
export function registerCarBody(spec: CarBodySpec): void {
  const known = byId.get(spec.id);
  if (known !== undefined && known !== spec) throw new Error(`car body '${spec.id}' is already registered`);
  byId.set(spec.id, spec);
}
