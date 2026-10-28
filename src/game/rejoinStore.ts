/**
 * "Back to your match" (plan PR 12): the server match this tab plays, in sessionStorage
 * (REJOIN_KEY), so a reload, a lost connection or a trip to the menus can come back to it through
 * POST /api/rejoin (NetClient.rejoin). OnlineSession writes it with the first Welcome and keeps its
 * end time from the clock; an explicit quit, the whistle, a cancelled match or a rejoin that says the
 * match is over clear it. P2P rooms are never written (the server never rejoins one). Inicio's hero
 * reads it (homeModel.ts HeroRejoin). Pure but for the storage, which is injectable (tests).
 */
import type { GameMode } from '../sim/constants';
import { STORAGE_PREFIX } from '../brand';

export const REJOIN_KEY = STORAGE_PREFIX + 'rejoin';
/** A record this old is dropped whatever it says (a tab left open overnight). */
export const REJOIN_MAX_AGE_MS = 2 * 60 * 60_000;
/** A match without a known end (unlimited, overtime) is offered this long after the last news of it. */
export const REJOIN_OPEN_MS = 10 * 60_000;
/** Past its regulation time a match may still be in overtime: offered this much longer. */
export const REJOIN_OVERTIME_MS = 90_000;

export interface RejoinRecord {
  matchId: string;
  kind: 'casual' | 'ranked';
  modes: GameMode[];
  /** Date.now() when its regulation time ends; null when unknown (unlimited, overtime). */
  endsAt: number | null;
  /** Date.now() of the last write. */
  savedAt: number;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function session(): StorageLike | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
}

/** The record still worth offering at `now`, else null (and an unreadable or stale one is removed). */
export function readRejoin(now = Date.now(), store: StorageLike | null = session()): RejoinRecord | null {
  if (store === null) return null;
  let r: RejoinRecord | null = null;
  try {
    const v: unknown = JSON.parse(store.getItem(REJOIN_KEY) ?? 'null');
    if (v !== null && typeof v === 'object') r = v as RejoinRecord;
  } catch {
    r = null;
  }
  const ok =
    r !== null &&
    typeof r.matchId === 'string' &&
    (r.kind === 'casual' || r.kind === 'ranked') &&
    Array.isArray(r.modes) &&
    r.modes.length > 0 &&
    typeof r.savedAt === 'number' &&
    now - r.savedAt < REJOIN_MAX_AGE_MS &&
    (typeof r.endsAt === 'number' ? now < r.endsAt + REJOIN_OVERTIME_MS : now - r.savedAt < REJOIN_OPEN_MS);
  if (!ok) {
    if (r !== null) clearRejoin(store);
    return null;
  }
  return r;
}

export function saveRejoin(r: RejoinRecord, store: StorageLike | null = session()): void {
  try {
    store?.setItem(REJOIN_KEY, JSON.stringify(r));
  } catch {
    /* storage full or blocked: no way back after a reload, the rest works */
  }
}

export function clearRejoin(store: StorageLike | null = session()): void {
  try {
    store?.removeItem(REJOIN_KEY);
  } catch {
    /* blocked */
  }
}

/** The time left to show for `r` at `now` (ms, 0 when unknown). */
export function rejoinLeftMs(r: RejoinRecord, now = Date.now()): number {
  return r.endsAt === null ? 0 : Math.max(0, r.endsAt - now);
}
