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
 *                     (seatCars; the node answer's `cars` ride on NetClient's MatchAssignment)
 *
 * The account routes' answers (inventory, the car pick, the shop and a claim) are read leniently
 * here too (walletOf, itemsAnswerOf, shopAnswerOf, claimAnswerOf: AccountClient), for the garage.
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

/**
 * The client rule (Game.applyOnlineRoster / applyP2PRoster): the car of each seat in slot order,
 * from `seats` (a Welcome's roster entries or a room's slots, { slot, car? } in any order) and a
 * node answer's `cars` (absent or null: none): the seat's own car, else the answer's for its slot,
 * else the default car. An id this page does not know reads as the default car, like a field of
 * another shape. A bot of the matchmaker's fill never carries one; a seat its player left keeps
 * theirs (the server keeps it on the bot that takes over, so no car changes body mid-match).
 */
export function seatCars(seats: ReadonlyArray<{ slot: number; car?: unknown }>, cars?: ReadonlyArray<CarId | null> | null): CarId[] {
  return seats
    .slice()
    .sort((a, b) => a.slot - b.slot)
    .map((s) => seatCar(s.car) ?? seatCar(cars?.[s.slot]) ?? DEFAULT_CAR);
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

// ---- the answers as the game reads them (AccountClient): lenient, a field of another shape is dropped ----

const ITEM_KINDS: readonly unknown[] = ['car', 'paint', 'boost', 'goal', 'badge', 'title'] satisfies ItemKind[];
const ITEM_STATUSES: readonly unknown[] = ['available', 'soon', 'retired'] satisfies ItemStatus[];
const CLAIM_BLOCKS: readonly unknown[] = ['unknown_item', 'not_available', 'frozen', 'insufficient', 'requires_matches'] satisfies Array<ShopItemView['blocked']>;

function fields(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

/** Host points from a field: a finite number not below 0, else 0. */
function points(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** A wallet from an answer: points that do not read as points are 0, `frozen` a reason or null. */
export function walletOf(v: unknown): Wallet {
  const o = fields(v);
  return { earned: points(o.earned), spent: points(o.spent), balance: points(o.balance), frozen: typeof o.frozen === 'string' && o.frozen.length > 0 ? o.frozen : null };
}

/** GET /api/me/items as the game reads it: `car` the default one unless it is a catalog id, `cars` from both lists. */
export function itemsAnswerOf(v: unknown): ItemsAnswer {
  const o = fields(v);
  const items = strings(o.items);
  return { items, car: seatCar(o.car) ?? DEFAULT_CAR, cars: entitledCarsOf([...items, ...strings(o.cars)]) };
}

/** GET /api/me/shop as the game reads it: an item without an id, a known kind or a known status is left out. */
export function shopAnswerOf(v: unknown): ShopAnswer {
  const o = fields(v);
  const items: ShopItemView[] = [];
  for (const raw of Array.isArray(o.items) ? o.items : []) {
    const it = fields(raw);
    if (typeof it.id !== 'string' || !ITEM_KINDS.includes(it.kind) || !ITEM_STATUSES.includes(it.status)) continue;
    const view: ShopItemView = {
      id: it.id,
      kind: it.kind as ItemKind,
      name: typeof it.name === 'string' ? it.name : it.id,
      description: typeof it.description === 'string' ? it.description : '',
      cost: points(it.cost),
      status: it.status as ItemStatus,
      owned: it.owned === true,
      claimable: it.claimable === true,
    };
    if (CLAIM_BLOCKS.includes(it.blocked)) view.blocked = it.blocked as ShopItemView['blocked'];
    if (typeof it.minVerifiedMatches === 'number') view.minVerifiedMatches = it.minVerifiedMatches;
    items.push(view);
  }
  return { items, wallet: walletOf(o.wallet) };
}

/** POST /api/me/shop/claim's answer as the game reads it. */
export function claimAnswerOf(v: unknown): ClaimAnswer {
  const o = fields(v);
  return { item: typeof o.item === 'string' ? o.item : '', claimed: o.claimed === true, wallet: walletOf(o.wallet), items: strings(o.items) };
}
