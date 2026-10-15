/**
 * Training pack records: the best completed run per pack, persisted in localStorage under
 * TRAINING_RECORDS_KEY as one JSON object `{ "<pack id>": { best, shots, completedAt } }`.
 *
 * Pure apart from the storage it is handed: the default is `globalThis.localStorage`, looked up
 * lazily, and EVERY access (the lookup itself included: a sandboxed iframe throws SecurityError
 * on the property read) is wrapped in try/catch, so private mode / disabled storage only means
 * nothing is remembered. Node tests pass a fake storage.
 *
 * Saved data is validated on load (parseTrainingRecords): unknown shapes, out-of-range numbers and
 * keys that are not plain pack ids are dropped, so corrupt storage can never reach the menu.
 */

import { STORAGE_PREFIX } from '../brand';

export const TRAINING_RECORDS_KEY = STORAGE_PREFIX + 'training.v1';

export interface TrainingRecord {
  /** Most shots passed in one completed run (every shot of the pack has a result). */
  best: number;
  /** Shot count of the pack when `best` was set; a pack whose length changed starts over. */
  shots: number;
  /** When the run that set `best` ended (ms since the epoch). */
  completedAt?: number;
}

export type TrainingRecords = Record<string, TrainingRecord>;

/** The part of Web Storage the records use (injectable for node tests). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Pack ids are lower-case words joined by '-' ('shooting-easy'); this also rules out '__proto__'. */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SHOTS = 1000;

function defaultStorage(): StorageLike | null {
  try {
    const ls = (globalThis as { localStorage?: StorageLike }).localStorage;
    return ls !== undefined && ls !== null ? ls : null;
  } catch {
    return null;
  }
}

function isCount(v: unknown, lo: number, hi: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
}

/** Validate decoded JSON into records (anything malformed is dropped entry by entry). */
export function parseTrainingRecords(raw: unknown): TrainingRecords {
  const out: TrainingRecords = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const id of Object.keys(raw)) {
    if (!ID_RE.test(id)) continue;
    const r = (raw as Record<string, unknown>)[id];
    if (typeof r !== 'object' || r === null) continue;
    const rec = r as Partial<Record<keyof TrainingRecord, unknown>>;
    if (!isCount(rec.shots, 1, MAX_SHOTS) || !isCount(rec.best, 0, rec.shots)) continue;
    const entry: TrainingRecord = { best: rec.best, shots: rec.shots };
    if (typeof rec.completedAt === 'number' && Number.isFinite(rec.completedAt) && rec.completedAt >= 0) entry.completedAt = rec.completedAt;
    out[id] = entry;
  }
  return out;
}

/** Every saved pack record ({} when storage is empty, unavailable or corrupt). */
export function loadTrainingRecords(storage: StorageLike | null = defaultStorage()): TrainingRecords {
  if (storage === null) return {};
  try {
    const text = storage.getItem(TRAINING_RECORDS_KEY);
    if (text === null) return {};
    return parseTrainingRecords(JSON.parse(text));
  } catch {
    return {};
  }
}

export interface RecordUpdate {
  /** The record as stored now (or as it would be, when storage is unavailable). */
  record: TrainingRecord;
  /** This run beat the previous best (or is the first completed run of the pack). */
  newBest: boolean;
}

/**
 * A completed run of `packId`: `passed` of `shots` shots. Keeps the best result per pack (a tie
 * keeps the older record and its date); a stored record for a different shot count is replaced.
 * Writes only when the record changes.
 */
export function saveTrainingResult(
  packId: string,
  passed: number,
  shots: number,
  now: number = Date.now(),
  storage: StorageLike | null = defaultStorage(),
): RecordUpdate {
  const total = Math.max(1, Math.min(MAX_SHOTS, Math.floor(shots)));
  const best = Math.max(0, Math.min(total, Math.floor(passed)));
  const all = loadTrainingRecords(storage);
  const prev = all[packId];
  if (prev !== undefined && prev.shots === total && prev.best >= best) return { record: prev, newBest: false };
  const record: TrainingRecord = { best, shots: total, completedAt: now };
  if (!ID_RE.test(packId)) return { record, newBest: true };
  all[packId] = record;
  if (storage !== null) {
    try {
      storage.setItem(TRAINING_RECORDS_KEY, JSON.stringify(all));
    } catch {
      /* quota / private mode: the run still counts on screen */
    }
  }
  return { record, newBest: true };
}
