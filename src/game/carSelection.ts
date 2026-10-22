/**
 * The local player's car: a pick kept in this browser (localStorage `turbogol.car`) that only ever
 * holds a car the player is entitled to. For now everyone is entitled to the default car alone;
 * the inventory API (a later change: the account's cars) extends `entitledCars` and nothing else
 * here changes. A saved id the player is not, or no longer, entitled to reads as the default car.
 *
 * Who drives what (Game.rosterCars): the player's car offline and in training is this pick; bots
 * always drive the default car; online every car is the default one until the rosters carry cars
 * (a later change, outside the protocol files the community nodes bundle).
 *
 * Development and the owner's device tests can preview any car (`previewCarsAllowed`: a dev
 * server, or a build made with VITE_PREVIEW_CARS=1): `#car=<id>` drives it offline whether owned
 * or not, `#showroom=<yaw>[,<pitch>]` frames it (Game.enterShowroom). Production builds ignore both.
 */
import { STORAGE_PREFIX } from '../brand';
import { DEFAULT_CAR, isCarId, type CarId } from './cosmetics';

/** localStorage key of the pick. */
export const CAR_PICK_KEY = STORAGE_PREFIX + 'car';

/** The cars this player may drive. The inventory API extends this (a later change). */
export function entitledCars(): readonly CarId[] {
  return [DEFAULT_CAR];
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
