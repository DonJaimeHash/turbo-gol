/**
 * ENTRENAMIENTO's decisions (plan PR 13, dir-hub §6.5), pure: what each pack's difficulty mark
 * shows (by shape: passed ✓, played, not played), where the pack sheet's focus starts, the level a
 * summary's NEXT LEVEL opens, and the device the screen's subtitle, the controls sheet and the
 * training HUD's hints speak to. tests/training-screen.test.mjs.
 */
import type { TrainingCategory, TrainingDifficulty, TrainingPack } from '../../game/trainingPacks';
import type { TrainingRecord, TrainingRecords } from '../../game/trainingRecords';
import type { InputKind } from '../device';

/** A difficulty's mark: 'done' every shot of the pack in one run (filled ✓), 'tried' played, 'none' never. */
export type MarkState = 'done' | 'tried' | 'none';

export interface PackMark {
  readonly pack: TrainingPack;
  readonly state: MarkState;
  /** The best run's passed shots, null when never played. */
  readonly best: number | null;
}

/** A pack's mark from its record (a record of an older pack length counts as not played). */
export function markOf(pack: TrainingPack, rec: TrainingRecord | undefined): PackMark {
  if (rec === undefined || rec.shots !== pack.shots.length) return { pack, state: 'none', best: null };
  return { pack, state: rec.best >= pack.shots.length ? 'done' : 'tried', best: rec.best };
}

/** The category's three marks, easy to hard (the packs' own order). */
export function categoryMarks(packs: readonly TrainingPack[], records: TrainingRecords, category: TrainingCategory): PackMark[] {
  return packs.filter((p) => p.category === category).map((p) => markOf(p, records[p.id]));
}

/** Where the pack sheet's focus starts: the first level not passed yet, else the hardest. */
export function firstOpen(marks: readonly PackMark[]): number {
  const i = marks.findIndex((m) => m.state !== 'done');
  return i >= 0 ? i : marks.length - 1;
}

/** NEXT LEVEL after `packId`: the same category's next difficulty, null after the hardest (or an unknown id). */
export function nextLevel(packs: readonly TrainingPack[], packId: string, order: readonly TrainingDifficulty[]): TrainingPack | null {
  const pack = packs.find((p) => p.id === packId);
  if (pack === undefined) return null;
  const d = order[order.indexOf(pack.difficulty) + 1];
  return d === undefined ? null : (packs.find((p) => p.category === pack.category && p.difficulty === d) ?? null);
}

/** The device the training texts speak to: a controller (a TV remote too: it plays with one), a finger, or keyboard and mouse. */
export type TrainDevice = 'kbm' | 'pad' | 'touch';

export function trainDevice(input: InputKind): TrainDevice {
  return input === 'pad' || input === 'remote' ? 'pad' : input === 'touch' ? 'touch' : 'kbm';
}
