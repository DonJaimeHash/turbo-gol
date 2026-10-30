/**
 * The pure part of the sheets that come back from a provider (screens/accountLinks.ts; tests in
 * tests/account-links.test.mjs): the one arbiter of URL-driven sheets (the sign-in design's §3.0
 * urlSheets), the "came here to sign in" detour of MODOS and GARAJE kept across a provider's round
 * trip (sessionStorage, never localStorage: I5), and the in-game name the confirm sheet offers.
 * No DOM.
 */
import { STORAGE_PREFIX } from '../../brand';
import { usernameIssue } from '../../net/account';

/**
 * The URL-driven sheets, one after another in a fixed order (Game.ts: the OAuth result `#auth=…`
 * and its confirm sheet, then the phone's /tv): each step waits until every step before it is done,
 * whichever installs first, so a sheet that replaces another never drops the next one's turn.
 */
export class UrlSheets<S extends string> {
  private readonly order: readonly S[];
  private readonly finished = new Set<S>();
  private readonly waiting: Array<{ step: S; go: () => void }> = [];

  constructor(order: readonly S[]) {
    this.order = order;
  }

  /** Every step before `step` is done. */
  private clear(step: S): boolean {
    const i = this.order.indexOf(step);
    return this.order.slice(0, Math.max(0, i)).every((s) => this.finished.has(s));
  }

  /** Resolves once every step before `step` is done (at once when they are). */
  turn(step: S): Promise<void> {
    if (this.clear(step)) return Promise.resolve();
    return new Promise((go) => this.waiting.push({ step, go }));
  }

  /** `step` is over (its sheets closed, or it had none): the steps after it may start. */
  done(step: S): void {
    this.finished.add(step);
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      const w = this.waiting[i];
      if (this.clear(w.step)) {
        this.waiting.splice(i, 1);
        w.go();
      }
    }
  }

  /** `step` is done already. */
  isDone(step: S): boolean {
    return this.finished.has(step);
  }
}

// ---- the detour: MODOS' and GARAJE's SIGN IN, across a provider's round trip -----------------------

/** sessionStorage: `{ screen, tab?, at }` (§3.0 turbogol.auth.detour). */
export const DETOUR_KEY = STORAGE_PREFIX + 'auth.detour';
/** A detour lasts this long: a provider's round trip, and the confirm step after it. */
export const DETOUR_MS = 30 * 60_000;

/** The screens a sign-in comes back to, and the tab it was on. */
export interface Detour {
  screen: 'modes' | 'garage';
  tab?: string;
}

/** A kept detour (its JSON), null when there is none, it is stale or it names another screen. */
export function detourOf(raw: string | null, now: number): Detour | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as { screen?: unknown; tab?: unknown; at?: unknown };
    if ((v.screen !== 'modes' && v.screen !== 'garage') || typeof v.at !== 'number' || now - v.at > DETOUR_MS || now < v.at) return null;
    return typeof v.tab === 'string' && /^[a-z]{1,16}$/.test(v.tab) ? { screen: v.screen, tab: v.tab } : { screen: v.screen };
  } catch {
    return null;
  }
}

type SessionLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function session(): SessionLike | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
}

/** SIGN IN on MODOS or GARAJE opened PERFIL: the sign-in, by a provider's round trip too, comes back there. */
export function keepDetour(d: Detour, now: number = Date.now(), store: SessionLike | null = session()): void {
  try {
    store?.setItem(DETOUR_KEY, JSON.stringify({ ...d, at: now }));
  } catch {
    /* private mode: the in-page return still works */
  }
}

/** The screen came back (Back from PERFIL, or the sign-in's return): nothing waits any more. */
export function dropDetour(store: SessionLike | null = session()): void {
  try {
    store?.removeItem(DETOUR_KEY);
  } catch {
    /* nothing kept */
  }
}

/** The kept detour, once (it goes as it is read). */
export function takeDetour(now: number = Date.now(), store: SessionLike | null = session()): Detour | null {
  let raw: string | null = null;
  try {
    raw = store?.getItem(DETOUR_KEY) ?? null;
  } catch {
    return null;
  }
  dropDetour(store);
  return detourOf(raw, now);
}

// ---- the confirm sheet's name ----------------------------------------------------------------------

/**
 * The in-game name the confirm sheet offers (§3.1, §5.1): `word` ('Jugador' / 'Player') and the
 * guest's four digits when the page has them, else four of `random`; never from the provider or
 * the address. A name the rules refuse falls back to the word with new digits.
 */
export function namePrefill(word: string, guestDigits: string | null, random: () => number = Math.random): string {
  const digits = (): string => String(1000 + Math.floor(random() * 9000));
  const first = word + (guestDigits !== null && /^\d{4}$/.test(guestDigits) ? guestDigits : digits());
  if (usernameIssue(first) === null) return first;
  const again = 'Player' + digits();
  return usernameIssue(again) === null ? again : 'Player1000';
}
