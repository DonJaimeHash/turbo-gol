/**
 * The cosmetic cars online: what each seat drives, and the inventory and hosts' shop answers of the
 * account routes (server/src/accountRoutes.ts). Shared by the client and the Worker.
 *
 * Not in the community nodes' bundle, and it must stay out (tests/cosmetics.test.mjs walks it): the
 * fields a car adds to the bundled wire types (src/net/protocol.ts Welcome and QueueResult,
 * server/src/roomHost.ts RosterEntry) are declared here as extensions, so neither a new car nor
 * this field ever changes a file the nodes run, and PROTOCOL_VERSION stays as it is. Fold them back
 * into those files at the next node release that changes them anyway.
 *
 * A car rides with its seat the way the player's name does: decided once, when the matchmaker forms
 * the match, from the account session (AccountsDO signs only a car the account still owns), never
 * from a request body. Absent = the default car: a bot, a guest, an account that never picked one,
 * a page or a server from before this field. Every reader ignores what it does not know (the
 * Welcome is a plain cast, RoomClient checks only the protocol), so old pages see the default car
 * for everyone and new pages on old answers too. A car is only a body: every one is
 * CarPreset.Standard (the same hitbox, wheels and physics), ranked or not.
 *
 *   MatchDO match     Welcome.roster[i].car (CosmeticWelcome), on every welcome, a rejoin's too
 *   P2P room          RoomSlot.car (src/net/p2p/protocol.ts: that file is not bundled either)
 *   node match        `cars` by slot (MatchedCars) in the queue result and the rejoin answer: the
 *                     node itself never hears of cars (its assignment is unchanged, byte for byte)
 *   client rule       car of slot i = welcome.roster[i].car ?? slots[i].car ?? result.cars?.[i] ?? DEFAULT_CAR
 */
import { CAR_IDS, DEFAULT_CAR, isCarId } from '../game/cosmetics';
import type { CarId } from '../game/cosmetics';
import type { QueueResult, Welcome } from './protocol';

/** A seat's car on the wire: absent = the default car. */
export interface SeatCar {
  car?: CarId;
}

/** The MatchDO's Welcome: each roster entry with its car. */
export type CosmeticWelcome = Omit<Welcome, 'roster'> & { roster: Array<Welcome['roster'][number] & SeatCar> };

/** A node match's cars, indexed by slot (null: a bot, or a seat on the default car); absent when every seat drives the default. */
export interface MatchedCars {
  cars?: Array<CarId | null>;
}

/** The queue result of a node match (and its rejoin answer) with its cars. */
export type CosmeticQueueResult = QueueResult & MatchedCars;

/** The most seats a match has (3v3). */
const MAX_SEATS = 6;

/** A car id from a JSON field, or undefined (anything else is dropped, never refused). */
export function seatCar(v: unknown): CarId | undefined {
  return isCarId(v) ? v : undefined;
}

/**
 * `cars` of a node answer when it reads as one (an array of at most six car ids or nulls), else
 * undefined: a field of another shape is dropped like any unknown one.
 */
export function carsOf(v: unknown): Array<CarId | null> | undefined {
  if (!Array.isArray(v) || v.length > MAX_SEATS || !v.every((c) => c === null || isCarId(c))) return undefined;
  return v as Array<CarId | null>;
}

/**
 * Cars by slot for seats `seats` ({ slot, car? }) of a match with `size` slots, or undefined when
 * every seat drives the default car (the answer then has no `cars` at all, as before cars existed).
 */
export function carsBySlot(size: number, seats: ReadonlyArray<{ slot: number; car?: CarId }>): Array<CarId | null> | undefined {
  if (!seats.some((s) => s.car !== undefined)) return undefined;
  const out: Array<CarId | null> = Array.from({ length: Math.max(0, Math.min(MAX_SEATS, size)) }, () => null);
  for (const s of seats) if (s.car !== undefined && Number.isInteger(s.slot) && s.slot >= 0 && s.slot < out.length) out[s.slot] = s.car;
  return out;
}

// ---- the account routes: inventory and the hosts' shop (nodes/control-plane/shop.ts) -----------------

/** GET /api/me/items: the item ids the account owns (sorted), the car it drives and every car it may drive (menu order). */
export interface ItemsAnswer {
  items: string[];
  car: CarId;
  cars: CarId[];
}

/** The cars an owner of `items` may drive, in menu order: the default car and each owned one. */
export function entitledCarsOf(items: readonly string[]): CarId[] {
  return CAR_IDS.filter((id) => id === DEFAULT_CAR || items.includes(id));
}

export type ItemKind = 'car' | 'paint' | 'boost' | 'goal' | 'badge' | 'title';
/** 'available': claimable; 'soon': announced, the game does not have it yet; 'retired': kept by its owners, not claimable. */
export type ItemStatus = 'available' | 'soon' | 'retired';

export interface CatalogItem {
  id: string;
  kind: ItemKind;
  name: string;
  description: string;
  /** Host points. */
  cost: number;
  status: ItemStatus;
  /** Verified hosted matches needed before the item can be claimed (the free badge needs one). */
  minVerifiedMatches?: number;
  /** A car: the locale keys of its name and description (src/game/cosmetics.ts), which the game shows instead. */
  nameKey?: string;
  descKey?: string;
}

/** Points earned by hosting (all time) minus those spent = balance (never below 0); `frozen`: why claims are paused, or null. */
export interface Wallet {
  earned: number;
  spent: number;
  balance: number;
  frozen: string | null;
}

/** Why an item cannot be claimed now. */
export type ClaimRefusal = 'unknown_item' | 'not_available' | 'owned' | 'frozen' | 'insufficient' | 'requires_matches';

export interface ShopItemView extends CatalogItem {
  owned: boolean;
  claimable: boolean;
  /** Why it cannot be claimed now (absent when it can, or when it is owned). */
  blocked?: Exclude<ClaimRefusal, 'owned'>;
}

/** GET /api/me/shop: the catalog as this account sees it and its wallet. */
export interface ShopAnswer {
  items: ShopItemView[];
  wallet: Wallet;
}

/**
 * POST /api/me/shop/claim { item }: `claimed` false when the account already owned it (a retried
 * claim spends nothing twice); the wallet and the owned item ids after it.
 */
export interface ClaimAnswer {
  item: string;
  claimed: boolean;
  wallet: Wallet;
  items: string[];
}
