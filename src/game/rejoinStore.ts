/**
 * "Back to your match" (plan PR 12): the server match this tab plays, in sessionStorage
 * (REJOIN_KEY), so a reload, a lost connection or a trip to the menus can come back to it through
 * POST /api/rejoin (NetClient.rejoin). OnlineSession writes it with the first Welcome and keeps its
 * end time from the clock; an explicit quit, the whistle, a cancelled match or a rejoin that says the
 * match is over clear it. P2P rooms are never written (the server never rejoins one). Inicio's hero
 * reads it (homeModel.ts HeroRejoin). Pure but for the storage, which is injectable (tests).
 *
 * The Sala this tab is in goes the same way across any reload (the player's, Super low's restart:
 * Game.keepLobby on pagehide, LOBBY_STAY_KEY): the next page joins it again by code (lobby.ts
 * installLobbyReturn), as a dropped socket does (LobbyDO keeps the place, host included).
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
  /** What the match was: a queue's, or a custom lobby's server match (its FINAL goes back to the lobby). */
  kind: 'casual' | 'ranked' | 'lobby';
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
    (r.kind === 'casual' || r.kind === 'ranked' || r.kind === 'lobby') &&
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

export const LOBBY_STAY_KEY = STORAGE_PREFIX + 'lobbyStay';
/**
 * A Sala's record read within this long of the reload comes back as it was: LobbyDO's LOBBY_GRACE_MS
 * (the server keeps the place and the host role that long; tests/lobby-model.test.mjs pins them
 * equal). Later (`late`) the place may be gone: joined again all the same while LOBBY_STAY_LATE_MS
 * lasts (the code and the password still open it), maybe as somebody new; past that the page says
 * the Sala went on without this player (`gone`).
 */
export const LOBBY_STAY_MS = 40_000;
/** LobbyClient's RECONNECT_WINDOW_MS: a dropped socket tries to join again this long too (the test pins them). */
export const LOBBY_STAY_LATE_MS = 90_000;

export interface LobbyStay {
  code: string;
  /** The password typed to join or create it (LobbyClient.password). */
  password: string | null;
  /** Date.now() of the write (just before the reload). */
  savedAt: number;
  /** The Sala's screen opens after the join (it was on the menus' stack); else the menus stay on Inicio. */
  open?: boolean;
  /** Read past LOBBY_STAY_MS: joined again, the place maybe gone (the host role passed on). */
  late?: boolean;
  /** Read past LOBBY_STAY_LATE_MS: not joined again. */
  gone?: boolean;
}

export function saveLobbyStay(s: LobbyStay, store: StorageLike | null = session()): void {
  try {
    store?.setItem(LOBBY_STAY_KEY, JSON.stringify(s));
  } catch {
    /* storage full or blocked: the reload leaves the Sala, as a closed tab does */
  }
}

/** The Sala to join again at `now`, read once (the record goes): `late` past LOBBY_STAY_MS, `gone` past LOBBY_STAY_LATE_MS; else null. */
export function takeLobbyStay(now = Date.now(), store: StorageLike | null = session()): LobbyStay | null {
  if (store === null) return null;
  let v: unknown = null;
  try {
    const raw = store.getItem(LOBBY_STAY_KEY);
    if (raw === null) return null;
    store.removeItem(LOBBY_STAY_KEY);
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (v === null || typeof v !== 'object') return null;
  const r = v as LobbyStay;
  const ok = typeof r.code === 'string' && r.code.length > 0 && (r.password === null || typeof r.password === 'string') && typeof r.savedAt === 'number' && now - r.savedAt >= 0;
  if (!ok) return null;
  const stay: LobbyStay = { code: r.code, password: r.password, savedAt: r.savedAt, open: r.open !== false };
  const age = now - r.savedAt;
  return age < LOBBY_STAY_MS ? stay : age < LOBBY_STAY_LATE_MS ? { ...stay, late: true } : { ...stay, gone: true };
}

/** The time left to show for `r` at `now` (ms, 0 when unknown). */
export function rejoinLeftMs(r: RejoinRecord, now = Date.now()): number {
  return r.endsAt === null ? 0 : Math.max(0, r.endsAt - now);
}
