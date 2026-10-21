/**
 * The safety net of the quality tiers: when a tier breaks on a device (GPU validation errors, a
 * WebGL program that fails to link, a lost device or context) soon after the boot or a tier
 * switch, the game falls back one tier (ultra -> high -> low -> super low), remembers the highest
 * tier that has not failed for that GPU in localStorage, and tells the player in one short line. It
 * never loops: a fallback only ever goes down, a failure during a fallback is the fallback's own,
 * and super low has nothing below it (a fallback into it reloads the page: its backend and world
 * are its own, quality.ts needsReload). A tier the player picks again later is tried again (their
 * choice), and if it fails again it falls again.
 *
 *   window     validation errors count for FALLBACK_WINDOW_MS after the tier started rendering
 *              (boot or switch): a broken tier fails in its first frames, while a rare error much
 *              later (one effect, one edge case) is not worth a lower tier for good. A lost device
 *              always counts (it renders nothing more).
 *   lost       the device is gone: the game stores the lower ceiling and reloads the page, which
 *              starts at most on it (Game.onGpuFailure). A device lost while the page was in the
 *              background, or in the first seconds back (BACKGROUND_LOSS_MS: a phone's system
 *              reclaimed the GPU while another app ran), is not the tier's: the page reloads on the
 *              same tier and no ceiling is written. On super low, with nothing below, a lost
 *              device also reloads on it (the only way back to a picture). Every reload after a
 *              lost device goes through the tab's counter (`lossStep`, sessionStorage): the first
 *              reloads as planned, the second reloads on super low whatever the tier (the tab's
 *              recovery, never saved: bootTier.ts 'recover'), the third shows a message and stops
 *              (a device that loses its GPU after every boot, a 1 GB TV under memory pressure whose
 *              boot takes longer than any time gate, never reloads forever). The count starts over
 *              after LOSS_COUNT_RESET_MS without a loss.
 *   ceiling    per GPU key (capabilities.ts `gpu`: backend, compatibility mode and the adapter's
 *              or the unmasked WebGL renderer's name), expiring after CEILING_TTL_MS so a later
 *              build or driver gets another chance; at most MAX_CEILINGS GPUs are kept. A tier
 *              above it that the player picks in the menu and that runs through the whole window
 *              without a failure lifts it to that tier (`raiseCeiling`, Game.switchQuality).
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
/** A device lost within this long (ms) after the page was last hidden is the background's, not the tier's. */
export const BACKGROUND_LOSS_MS = 10000;
/** localStorage key of the ceilings: { [gpu]: { q, at } }. */
export const CEILING_KEY = STORAGE_PREFIX + 'tierCeiling.v1';
/** A lost device more than this long (ms) after the previous one starts the tab's count over. */
export const LOSS_COUNT_RESET_MS = 5 * 60 * 1000;
/** sessionStorage: the tab's lost devices, { n, at } (lossStep). */
export const LOSS_COUNT_KEY = STORAGE_PREFIX + 'gpuLost.v1';
/** sessionStorage: '1' while the tab recovers on super low after its second lost device (bootTier.ts 'recover'). */
export const RECOVER_KEY = STORAGE_PREFIX + 'recover';
/**
 * sessionStorage: a tier the player picked that needs a reload (into or out of super low). The
 * next boot runs it once even above the GPU's ceiling, and a clean fallback window lifts the
 * ceiling (Game.bootDone, raiseCeiling); otherwise a ceiling at super low could never be left.
 */
export const TRY_TIER_KEY = STORAGE_PREFIX + 'tryTier';

export type FailureKind = 'error' | 'lost';

/** What to do about a failure: switch to `to` (a reload first when the device is lost; `to` === `from`: a reload on the same tier, no ceiling). */
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
 * The player picked `q` in the menu and it ran through the whole fallback window without a
 * failure: a ceiling below it is lifted to it (none is left when `q` is the top tier), so the
 * next boot starts on the player's choice again instead of the old fallback's tier for the rest
 * of the record's 30 days (a driver or a build that has since been fixed). A record at or above
 * `q` stays as it is.
 */
export function raiseCeiling(store: Store | null, gpu: string, q: Quality, now: number): void {
  if (store === null) return;
  const all = readAll(store);
  const old = all[gpu];
  if (old === undefined || QUALITIES.indexOf(old.q) >= QUALITIES.indexOf(q)) return;
  if (QUALITIES.indexOf(q) === QUALITIES.length - 1) delete all[gpu];
  else all[gpu] = { q, at: now };
  try {
    store.setItem(CEILING_KEY, JSON.stringify(all));
  } catch {
    /* storage full or disabled */
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

  /**
   * A failure of kind `kind` while `current` renders: the fallback to make, or null (nothing to
   * do). `background`: the page is hidden or was within BACKGROUND_LOSS_MS (a lost device then
   * reloads on the same tier).
   */
  onFailure(kind: FailureKind, current: Quality, background = false): Fallback | null {
    if (this.busy) return null;
    const to = lowerQuality(current);
    if (kind === 'lost' && (background || to === null)) {
      this.busy = true;
      return { from: current, to: current, reload: true };
    }
    if (to === null) return null;
    if (kind === 'error' && this.now() - this.armedAt > FALLBACK_WINDOW_MS) return null;
    this.busy = true;
    return { from: current, to, reload: kind === 'lost' };
  }
}

/** What a lost device does to the page (lossStep): reload as planned, reload on super low, or stop with a message. */
export type LossStep = 'reload' | 'recover' | 'stop';

/** The tab's lost devices so far (sessionStorage LOSS_COUNT_KEY). */
export interface LossRecord {
  readonly n: number;
  readonly at: number;
}

/** Parse the tab's record (null when absent or unreadable). Pure. */
export function parseLossRecord(raw: string | null): LossRecord | null {
  if (raw === null) return null;
  try {
    const r = JSON.parse(raw) as { n?: unknown; at?: unknown } | null;
    if (r !== null && typeof r.n === 'number' && typeof r.at === 'number' && Number.isFinite(r.n) && Number.isFinite(r.at)) return { n: r.n, at: r.at };
  } catch {
    /* garbage: a fresh count */
  }
  return null;
}

/**
 * Another lost device at `now` (ms since the epoch) after the tab's record `prev`: the new record
 * and the step (see the file header): 1st reload, 2nd recover on super low, 3rd and later stop.
 * A loss more than LOSS_COUNT_RESET_MS after the previous one (or a clock that went back) counts
 * as the first again. Pure.
 */
export function lossStep(prev: LossRecord | null, now: number): { step: LossStep; record: LossRecord } {
  const fresh = prev === null || now < prev.at || now - prev.at > LOSS_COUNT_RESET_MS;
  const n = fresh ? 1 : prev.n + 1;
  return { step: n <= 1 ? 'reload' : n === 2 ? 'recover' : 'stop', record: { n, at: now } };
}
