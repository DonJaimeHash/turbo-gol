/**
 * Experimental free play (training screen, signed-in players with Settings > Experimental's switch
 * on): which physics a training arena runs and how fast its clock goes. Pure (node tests); the Game
 * calls it from startTraining and when the pause menu's RULES (the settings screen in its
 * 'training' context) closes.
 *
 *   - Only free play takes rules. Shot packs always run stock physics (trainingPacks.ts builds its
 *     shots with stock gravity and radius), so `trainingRules` gives null for a pack whatever was
 *     asked, and for a player who is not unlocked.
 *   - Rules apply once, on a fresh arena before any car: `buildTrainingArena` is createArena with the
 *     plan's mutators, then addCar. Never per edit: the Game plans again when the settings close.
 *   - The arena keeps the fingerprint of the physics it was built with; going from one training to
 *     another rebuilds it whenever the wanted physics differ (`needsTrainingArena`), so a pack after
 *     experimental free play is stock again.
 *   - Game speed only changes the fixed-step accumulator (`accumulate`): fewer ticks per second of
 *     real time, never more (gameSpeedFactor is at most 1), so it adds no work.
 *   - Free play saves no records (TrainingSession records packs only), so other physics can never
 *     reach the training records or /api/me/training.
 */
import { rulesOf, type PhysicsRules, type PhysicsValues } from './physicsRules';
import { FREEPLAY_ID } from './trainingPacks';
import { arenaMutators, gameSpeedFactor } from '../sim/mutators';
import { STOCK_MUTATORS, mutatorFingerprint } from '../sim/mutatorLayout';
import type { CarPreset, Team } from '../sim/types';

/** The fingerprint of a stock arena (physicsFingerprint(null)). */
export const STOCK_ARENA_FINGERPRINT = mutatorFingerprint(STOCK_MUTATORS);

/**
 * The rules a training runs: `wanted` (a preset's values) only for free play and only for an
 * unlocked player; null (stock) for a pack, plain free play or a locked player.
 */
export function trainingRules(trainingId: string, wanted: Readonly<PhysicsValues> | null, unlocked: boolean): PhysicsRules | null {
  if (trainingId !== FREEPLAY_ID || wanted === null || !unlocked) return null;
  return rulesOf(wanted, 'training');
}

/** What a training arena is built with. */
export interface TrainingArenaPlan {
  /** createArena's mutators (null: the plain stock path). */
  readonly mutators: Float32Array | null;
  /** What the arena runs (STOCK_ARENA_FINGERPRINT for stock physics). */
  readonly fingerprint: number;
  /** The clock's speed (1 = real time; free play's game speed, never above 1). */
  readonly speed: number;
}

/** The plan for `rules` (null: stock). Throws on values off the table's grid (arenaMutators). */
export function planTrainingArena(rules: PhysicsRules | null): TrainingArenaPlan {
  const mutators = arenaMutators(rules);
  return {
    mutators,
    fingerprint: mutators === null ? STOCK_ARENA_FINGERPRINT : mutatorFingerprint(mutators),
    speed: rules === null ? 1 : Math.min(1, gameSpeedFactor(rules.values)),
  };
}

/** The part of the sim a training arena needs (RocketSim). */
export interface TrainingArenaSim {
  createArena(tickRate: number, mutators: Float32Array | null): void;
  addCar(team: Team, preset: CarPreset): number;
}

/** A fresh arena with the plan's physics, then the player's car (rules apply before any car exists). Returns the car id. */
export function buildTrainingArena(sim: TrainingArenaSim, plan: TrainingArenaPlan, tickRate: number, team: Team, preset: CarPreset): number {
  sim.createArena(tickRate, plan.mutators);
  return sim.addCar(team, preset);
}

/** A training arena is built when training starts, and again whenever the wanted physics differ from the arena's. */
export function needsTrainingArena(inTraining: boolean, arenaFingerprint: number, plan: TrainingArenaPlan): boolean {
  return !inTraining || arenaFingerprint !== plan.fingerprint;
}

/** The fixed-step accumulator after a frame of `dt` real seconds at `speed`, clamped to `max`. */
export function accumulate(acc: number, dt: number, speed: number, max: number): number {
  const a = acc + dt * speed;
  return a > max ? max : a;
}
