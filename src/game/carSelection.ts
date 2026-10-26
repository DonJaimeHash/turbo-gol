/**
 * The local player's car: a pick kept in this browser (localStorage `turbogol.car`) that only ever
 * holds a car the player is entitled to (`entitledCars`): the default car, plus each car the
 * signed-in account owns, which src/game/garage.ts keeps here (`setEntitledCars`: the session's car
 * at once, the inventory once /api/me/items or the shop answers, the default car alone again after
 * a sign-out). A saved id the player is not, or no longer, entitled to reads as the default car.
 *
 * Who drives what (Game.rosterCars): the player's car offline and in training is this pick; bots
 * always drive the default car; online each seat's car comes with the roster (src/net/cosmetics.ts
 * seatCars), decided by the server from the account session (AccountsDO signs only a car the
 * account still owns): online the server is the authority, and an account's pick follows it.
 *
 * Development and the owner's device tests can preview any car (`previewCarsAllowed`: a dev
 * server, or a build made with VITE_PREVIEW_CARS=1): `#car=<id>[,<id>...]` puts it on the offline
 * roster whether owned or not (the player's car, then the bots'), `#showroom=<yaw>[,<pitch>[,<slot>]]`
 * frames one (Game.enterShowroom). Production builds ignore both.
 */
import { STORAGE_PREFIX } from '../brand';
import { CAR_IDS, DEFAULT_CAR, isCarId, type CarId } from './cosmetics';

/** localStorage key of the pick. */
export const CAR_PICK_KEY = STORAGE_PREFIX + 'car';

/** What entitledCars answers: the default car alone until setEntitledCars says more (a guest's for good). */
let entitled: readonly CarId[] = [DEFAULT_CAR];

/** The cars this player may drive, in menu order: the default car and, signed in, each car the account owns. */
export function entitledCars(): readonly CarId[] {
  return entitled;
}

/**
 * The cars this player may drive from now on (src/game/garage.ts: the account's, none for a guest):
 * the default car is always in, anything that is not a catalog id is dropped, menu order. Returns
 * whether the set changed (the player's car may then be another one: the Garage tells the Game).
 */
export function setEntitledCars(cars: Iterable<unknown>): boolean {
  const want = new Set<unknown>(cars);
  const next = CAR_IDS.filter((id) => id === DEFAULT_CAR || want.has(id));
  if (next.length === entitled.length && next.every((id, i) => id === entitled[i])) return false;
  entitled = next;
  return true;
}

/** The storage the pick lives in: localStorage, a stand-in in tests, null for none. */
export type CarStorage = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): CarStorage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // storage disabled (a sandboxed frame)
  }
}

export class CarSelection {
  private readonly storage: CarStorage | null;
  private readonly entitled: () => readonly CarId[];
  private pick: CarId = DEFAULT_CAR;

  constructor(opts: { storage?: CarStorage | null; entitled?: () => readonly CarId[] } = {}) {
    this.storage = opts.storage !== undefined ? opts.storage : browserStorage();
    this.entitled = opts.entitled ?? entitledCars;
    let raw: string | null = null;
    try {
      raw = this.storage?.getItem(CAR_PICK_KEY) ?? null;
    } catch {
      /* private mode / storage disabled */
    }
    if (isCarId(raw)) this.pick = raw;
  }

  /** The car to drive: the pick while the player is entitled to it, else the default car. */
  get current(): CarId {
    return this.entitled().includes(this.pick) ? this.pick : DEFAULT_CAR;
  }

  /** Pick `id` when the player is entitled to it (saved for the next visits); returns whether it was taken. */
  select(id: CarId): boolean {
    if (!this.entitled().includes(id)) return false;
    this.pick = id;
    try {
      this.storage?.setItem(CAR_PICK_KEY, id);
    } catch {
      /* storage disabled: the pick holds for this page */
    }
    return true;
  }
}

/** The page environment the preview flags are gated on (Vite's import.meta.env). */
export interface PreviewEnv {
  readonly DEV?: boolean;
  readonly VITE_PREVIEW_CARS?: string;
}

/** `#car` and `#showroom` work: a dev server, or a build made with VITE_PREVIEW_CARS=1. */
export function previewCarsAllowed(env: PreviewEnv | undefined = import.meta.env): boolean {
  return env?.DEV === true || env?.VITE_PREVIEW_CARS === '1';
}
