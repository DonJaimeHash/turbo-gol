/**
 * Training pack records: the best completed run per pack, as one JSON object
 * `{ "<pack id>": { best, shots, completedAt } }`.
 *
 * Where they live (src/game/trainingStore.ts decides): a guest's in localStorage under
 * TRAINING_RECORDS_KEY; a signed-in account's on the server (AccountsDO, server/src/accountStore.ts)
 * with a local copy under accountRecordsKey(playerId). The server validates and merges with the
 * same functions (parseTrainingRecords, mergeTrainingRecords), so this module stays free of DOM and
 * i18n imports.
 *
 * Storage access: the default is `globalThis.localStorage`, looked up lazily, and EVERY access (the
 * lookup itself included: a sandboxed iframe throws SecurityError on the property read) is wrapped
 * in try/catch, so private mode / disabled storage only means nothing is remembered. Node tests pass
 * a fake storage.
 *
 * Saved data is validated on load (parseTrainingRecords): unknown shapes, out-of-range numbers and
 * keys that are not plain pack ids are dropped, so corrupt storage can never reach the menu.
 */

import { STORAGE_PREFIX } from '../brand';

export const TRAINING_RECORDS_KEY = STORAGE_PREFIX + 'training.v1';
/**
 * At most this many packs are kept per player (the game ships 9; room for more packs later, and 40
 * records stay well under the server's 4 KB request body).
 */
export const MAX_TRAINING_RECORDS = 40;

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
  removeItem?(key: string): void;
}

/** Pack ids are lower-case words joined by '-' ('shooting-easy'); this also rules out '__proto__'. */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SHOTS = 1000;

/** The local copy of an account's records (the account id is the session `sub`: 16 hex chars). */
export function accountRecordsKey(playerId: string): string {
  return TRAINING_RECORDS_KEY + '.' + playerId;
}

export function defaultTrainingStorage(): StorageLike | null {
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

/**
 * Validate decoded JSON into records (anything malformed is dropped entry by entry; at most
 * MAX_TRAINING_RECORDS packs are kept, the first ones in key order).
 */
export function parseTrainingRecords(raw: unknown): TrainingRecords {
  const out: TrainingRecords = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  let n = 0;
  for (const id of Object.keys(raw)) {
    if (n >= MAX_TRAINING_RECORDS) break;
    if (!ID_RE.test(id)) continue;
    const r = (raw as Record<string, unknown>)[id];
    if (typeof r !== 'object' || r === null) continue;
    const rec = r as Partial<Record<keyof TrainingRecord, unknown>>;
    if (!isCount(rec.shots, 1, MAX_SHOTS) || !isCount(rec.best, 0, rec.shots)) continue;
    const entry: TrainingRecord = { best: rec.best, shots: rec.shots };
    if (typeof rec.completedAt === 'number' && Number.isFinite(rec.completedAt) && rec.completedAt >= 0) entry.completedAt = rec.completedAt;
    out[id] = entry;
    n++;
  }
  return out;
}

/**
 * The better of two records of one pack: for the same shot count the higher best (a tie keeps `a`,
 * the older one when `a` is what was stored); for different shot counts (the pack changed length)
 * the more recent run, which is the one for the pack as it is now.
 */
export function betterRecord(a: TrainingRecord, b: TrainingRecord): TrainingRecord {
  if (a.shots === b.shots) return b.best > a.best ? b : a;
  return (b.completedAt ?? 0) > (a.completedAt ?? 0) ? b : a;
}

/** Pack by pack, the better record of `a` and `b` (betterRecord); a new object, inputs untouched. */
export function mergeTrainingRecords(a: TrainingRecords, b: TrainingRecords): TrainingRecords {
  const out: TrainingRecords = { ...a };
  for (const id of Object.keys(b)) {
    const prev = out[id];
    out[id] = prev === undefined ? b[id] : betterRecord(prev, b[id]);
  }
  return parseTrainingRecords(out);
}

/** True when both hold the same packs with the same numbers. */
export function sameTrainingRecords(a: TrainingRecords, b: TrainingRecords): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const id of ka) {
    const x = a[id];
    const y = b[id];
    if (y === undefined || x.best !== y.best || x.shots !== y.shots || x.completedAt !== y.completedAt) return false;
  }
  return true;
}

/** Every saved pack record under `key` ({} when storage is empty, unavailable or corrupt). */
export function loadTrainingRecords(storage: StorageLike | null = defaultTrainingStorage(), key: string = TRAINING_RECORDS_KEY): TrainingRecords {
  if (storage === null) return {};
  try {
    const text = storage.getItem(key);
    if (text === null) return {};
    return parseTrainingRecords(JSON.parse(text));
  } catch {
    return {};
  }
}

/** Store `records` under `key` (an empty object removes the key). False when storage refused. */
export function writeTrainingRecords(records: TrainingRecords, storage: StorageLike | null = defaultTrainingStorage(), key: string = TRAINING_RECORDS_KEY): boolean {
  if (storage === null) return false;
  try {
    if (Object.keys(records).length === 0 && storage.removeItem !== undefined) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(records));
    return true;
  } catch {
    return false; // quota / private mode: the run still counts on screen
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
 * Writes (under `key`) only when the record changes.
 */
export function saveTrainingResult(
  packId: string,
  passed: number,
  shots: number,
  now: number = Date.now(),
  storage: StorageLike | null = defaultTrainingStorage(),
  key: string = TRAINING_RECORDS_KEY,
): RecordUpdate {
  const total = Math.max(1, Math.min(MAX_SHOTS, Math.floor(shots)));
  const best = Math.max(0, Math.min(total, Math.floor(passed)));
  const all = loadTrainingRecords(storage, key);
  const prev = all[packId];
  if (prev !== undefined && prev.shots === total && prev.best >= best) return { record: prev, newBest: false };
  const record: TrainingRecord = { best, shots: total, completedAt: now };
  if (!ID_RE.test(packId)) return { record, newBest: true };
  all[packId] = record;
  if (storage !== null) {
    try {
      storage.setItem(key, JSON.stringify(all));
    } catch {
      /* quota / private mode: the run still counts on screen */
    }
  }
  return { record, newBest: true };
}
