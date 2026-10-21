/**
 * The safety net of the quality tiers: when a tier breaks on a device (GPU validation errors, a
 * WebGL program that fails to link, a lost device or context) soon after the boot or a tier
 * switch, the game falls back one tier (ultra -> high -> low), remembers the highest tier that has
 * not failed for that GPU in localStorage, and tells the player in one short line. It never loops:
 * a fallback only ever goes down, a failure during a fallback is the fallback's own, and low has
 * nothing below it. A tier the player picks again later is tried again (their choice), and if it
 * fails again it falls again.
 *
 *   window     validation errors count for FALLBACK_WINDOW_MS after the tier started rendering
 *              (boot or switch): a broken tier fails in its first frames, while a rare error much
 *              later (one effect, one edge case) is not worth a lower tier for good. A lost device
 *              always counts (it renders nothing more).
 *   lost       the device is gone: the game stores the lower ceiling and reloads the page, which
 *              starts at most on it (Game.onGpuFailure; at most two reloads, ultra -> high -> low).
 *   ceiling    per GPU key (capabilities.ts `gpu`: backend, compatibility mode and the adapter's
 *              or the unmasked WebGL renderer's name), expiring after CEILING_TTL_MS so a later
 *              build or driver gets another chance; at most MAX_CEILINGS GPUs are kept.
 *
 * Pure: the clock and the storage are passed in (node tests).
 */
import { STORAGE_PREFIX } from '../brand';
import { QUALITIES, lowerQuality, parseQuality, type Quality } from './quality';

/** Validation errors within this long (ms) after a tier started rendering make it fall back. */
export const FALLBACK_WINDOW_MS = 20000;
/** A remembered ceiling expires after this long (ms): 30 days. */
export const CEILING_TTL_MS = 30 * 24 * 3600 * 1000;
/** GPUs remembered at most (the oldest record goes first). */
export const MAX_CEILINGS = 8;
/** localStorage key of the ceilings: { [gpu]: { q, at } }. */
export const CEILING_KEY = STORAGE_PREFIX + 'tierCeiling.v1';

export type FailureKind = 'error' | 'lost';

/** What to do about a failure: switch to `to` (a reload first when the device is lost). */
export interface Fallback {
  readonly from: Quality;
  readonly to: Quality;
  readonly reload: boolean;
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;

interface CeilingRecord {
  q: Quality;
  at: number;
}

function readAll(store: Store | null): Record<string, CeilingRecord> {
  if (store === null) return {};
  try {
    const raw = store.getItem(CEILING_KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object') return {};
    const out: Record<string, CeilingRecord> = {};
    for (const [gpu, rec] of Object.entries(parsed as Record<string, unknown>)) {
      const r = rec as { q?: unknown; at?: unknown } | null;
      const q = parseQuality(r?.q);
      if (q !== null && typeof r?.at === 'number' && Number.isFinite(r.at)) out[gpu] = { q, at: r.at };
    }
    return out;
  } catch {
    return {};
  }
}

/** The highest tier that has not failed on `gpu` (null = none failed, or the record expired). */
export function readCeiling(store: Store | null, gpu: string, now: number): Quality | null {
  const rec = readAll(store)[gpu];
  if (rec === undefined || now - rec.at > CEILING_TTL_MS || now < rec.at) return null;
  return rec.q;
}

/** Remember `q` as the highest tier for `gpu` (a lower existing record that has not expired stays). */
export function writeCeiling(store: Store | null, gpu: string, q: Quality, now: number): void {
  if (store === null) return;
  const all = readAll(store);
  const old = all[gpu];
  const keepOld = old !== undefined && now - old.at <= CEILING_TTL_MS && QUALITIES.indexOf(old.q) <= QUALITIES.indexOf(q);
  if (!keepOld) all[gpu] = { q, at: now };
  const gpus = Object.keys(all).sort((a, b) => all[b].at - all[a].at);
  for (const g of gpus.slice(MAX_CEILINGS)) delete all[g];
  try {
    store.setItem(CEILING_KEY, JSON.stringify(all));
  } catch {
    /* storage full or disabled: this session still falls back */
  }
}

/**
 * Decides when a failure makes the tier fall back. `arm()` when a tier starts rendering (the end of
 * the boot, the start and the end of every switch); `onFailure()` for every failure the renderer
 * reports; `fallingBack` stays true from a decision until the next `arm()`.
 */
export class TierGuard {
  private armedAt = Number.NEGATIVE_INFINITY;
  private busy = false;
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  /** A fallback switch is pending or running (failures meanwhile are ignored). */
  get fallingBack(): boolean {
    return this.busy;
  }

  /** The tier now rendering is new (boot, a switch): its failures count for the window from now. */
  arm(): void {
    this.armedAt = this.now();
    this.busy = false;
  }

  /** A failure of kind `kind` while `current` renders: the fallback to make, or null (nothing to do). */
  onFailure(kind: FailureKind, current: Quality): Fallback | null {
    if (this.busy) return null;
    const to = lowerQuality(current);
    if (to === null) return null;
    if (kind === 'error' && this.now() - this.armedAt > FALLBACK_WINDOW_MS) return null;
    this.busy = true;
    return { from: current, to, reload: kind === 'lost' };
  }
}
