/**
 * The hosts' shop: points earned by sharing a machine are spent on new cars and other items.
 * Rule from the project: new things are ONLY for people who share resources. There is no other way
 * to get a catalog item: it cannot be bought with money, won by playing or traded.
 *
 *   wallet    earned (ledger, all time) - spent (claims) = balance. Frozen while a node of the
 *             operator is under review for a failed verification (no claims meanwhile).
 *   catalog   items with a cost and a status: 'available' (claimable), 'soon' (announced, not
 *             claimable yet: the game does not have it), 'retired' (kept by owners, not claimable).
 *             The cars are src/game/cosmetics.ts's, the one table of ids, prices and statuses the
 *             game reads too (a car is 'available' once its body is built): adding a car there
 *             lists it here. The default car is everyone's and never listed.
 *   inventory what an account owns; the game asks for it to unlock items (entitlements).
 *
 * Production keeps credits, claims, freezes and inventories in AccountsDO (server/src/accountStore.ts:
 * the same catalog and the same claim rules, claimBlock and catalogView below); the Shop class is the
 * in-memory version the reference server and the tests use. The wire types are src/net/cosmetics.ts's.
 */
import { CARS, DEFAULT_CAR } from '../../src/game/cosmetics';
import type { CarId } from '../../src/game/cosmetics';
import type { CatalogItem, ClaimRefusal, ItemKind, ItemStatus, ShopItemView, Wallet } from '../../src/net/cosmetics';
import type { Ledger } from './ledger';

export type { CatalogItem, ClaimRefusal, ItemKind, ItemStatus, ShopItemView, Wallet };

/** An item id (the cars' are their CarId). */
export const ITEM_ID_RE = /^[a-z0-9-]{3,40}$/;

/**
 * Each car's proper name, the same in every language: the locales' car.<id> (src/locales/*.ts,
 * checked by tests/cosmetics.test.mjs), mirrored for the shop's own texts because the Worker's
 * typecheck cannot load the game's locales (they are typed against the DOM). The game shows its
 * locale's name and description (nameKey / descKey).
 */
export const CAR_NAMES: Readonly<Record<CarId, string>> = { dune: 'Dune', pampero: 'Pampero', carpincho: 'Carpincho', condor: 'Cóndor', tero: 'Tero' };

/**
 * The catalog. The cars come from src/game/cosmetics.ts (the default car is everyone's: never
 * listed); the effects are placeholders ('soon') until the game has them: the shop already shows
 * what is coming, and nobody can claim what does not exist yet.
 */
export const CATALOG: readonly CatalogItem[] = [
  { id: 'badge-host', kind: 'badge', name: 'Anfitrión', description: 'Insignia en tu perfil y tu nombre en la pantalla de carga de las partidas de tu servidor.', cost: 0, status: 'available', minVerifiedMatches: 1 },
  ...CARS.filter((c) => c.id !== DEFAULT_CAR).map(
    (c): CatalogItem => ({ id: c.id, kind: 'car', name: CAR_NAMES[c.id], description: 'Un auto nuevo, solo para anfitriones.', cost: c.price, status: c.status, nameKey: c.nameKey, descKey: c.descKey }),
  ),
  { id: 'boost-next-1', kind: 'boost', name: 'Próxima estela de boost', description: 'Una estela exclusiva para anfitriones.', cost: 600, status: 'soon' },
  { id: 'goal-next-1', kind: 'goal', name: 'Próxima explosión de gol', description: 'Una explosión de gol exclusiva para anfitriones.', cost: 1000, status: 'soon' },
];

/** The catalog entry of `id` (CATALOG), or undefined. */
export function catalogItem(id: string): CatalogItem | undefined {
  return CATALOG.find((it) => it.id === id);
}

export interface Claim {
  operatorId: string;
  itemId: string;
  cost: number;
  at: number;
}

export type ClaimResult = { ok: true; claim: Claim; wallet: Wallet } | { ok: false; code: ClaimRefusal };

/** What a claim is checked against: the account's items, its freeze, its verified hosted matches and its balance. */
export interface ClaimState {
  owns(itemId: string): boolean;
  frozen: string | null;
  verifiedMatches: number;
  balance: number;
}

/** Why `it` cannot be claimed now (checked in this order), or null: the one rule, the Shop's and AccountsDO's. */
export function claimBlock(it: CatalogItem | undefined, s: ClaimState): ClaimRefusal | null {
  if (!it) return 'unknown_item';
  if (s.owns(it.id)) return 'owned';
  if (it.status !== 'available') return 'not_available';
  if (s.frozen !== null) return 'frozen';
  if ((it.minVerifiedMatches ?? 0) > s.verifiedMatches) return 'requires_matches';
  if (s.balance < it.cost) return 'insufficient';
  return null;
}

/** The catalog as an account sees it: retired items only when owned; claimable first, then by cost. */
export function catalogView(catalog: Iterable<CatalogItem>, s: ClaimState): ShopItemView[] {
  const out: ShopItemView[] = [];
  for (const it of catalog) {
    const owned = s.owns(it.id);
    if (it.status === 'retired' && !owned) continue;
    const blocked = claimBlock(it, s);
    out.push({ ...it, owned, claimable: blocked === null, ...(blocked && blocked !== 'owned' ? { blocked } : {}) });
  }
  return out.sort((a, b) => Number(a.status !== 'available') - Number(b.status !== 'available') || a.cost - b.cost);
}

export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export class Shop {
  private readonly ledger: Ledger;
  private readonly catalog = new Map<string, CatalogItem>();
  private readonly claims: Claim[] = [];
  private readonly owned = new Map<string, Set<string>>();
  private readonly frozen = new Map<string, string>();

  constructor(ledger: Ledger, catalog: readonly CatalogItem[] = CATALOG) {
    this.ledger = ledger;
    for (const it of catalog) this.catalog.set(it.id, { ...it });
  }

  // ---- catalog admin ----------------------------------------------------------------------

  /** Add or replace an item (a new car the game can now draw). */
  upsertItem(item: CatalogItem): void {
    if (!ITEM_ID_RE.test(item.id) || !(item.cost >= 0)) throw new Error('bad item');
    this.catalog.set(item.id, { ...item });
  }

  setItemStatus(itemId: string, status: ItemStatus): boolean {
    const it = this.catalog.get(itemId);
    if (!it) return false;
    it.status = status;
    return true;
  }

  // ---- wallet -----------------------------------------------------------------------------

  wallet(operatorId: string): Wallet {
    const earned = this.ledger.earned(operatorId);
    let spent = 0;
    for (const c of this.claims) if (c.operatorId === operatorId) spent += c.cost;
    return { earned, spent: round2(spent), balance: round2(earned - spent), frozen: this.frozen.get(operatorId) ?? null };
  }

  /** A node of this operator failed verification: no claims until a maintainer looks. */
  freeze(operatorId: string, reason: string): void {
    this.frozen.set(operatorId, reason);
  }

  unfreeze(operatorId: string): void {
    this.frozen.delete(operatorId);
  }

  // ---- items ------------------------------------------------------------------------------

  owns(operatorId: string, itemId: string): boolean {
    return this.owned.get(operatorId)?.has(itemId) ?? false;
  }

  /** Item ids the account owns: what the game unlocks for it. */
  inventory(operatorId: string): string[] {
    return [...(this.owned.get(operatorId) ?? [])].sort();
  }

  private state(operatorId: string): ClaimState {
    return { owns: (id) => this.owns(operatorId, id), frozen: this.frozen.get(operatorId) ?? null, verifiedMatches: this.ledger.verifiedMatches(operatorId), balance: this.wallet(operatorId).balance };
  }

  /** The catalog as this operator sees it (retired items only when owned). */
  view(operatorId: string): ShopItemView[] {
    return catalogView(this.catalog.values(), this.state(operatorId));
  }

  claim(operatorId: string, itemId: string, now: number): ClaimResult {
    const it = this.catalog.get(itemId);
    const blocked = claimBlock(it, this.state(operatorId));
    if (blocked || !it) return { ok: false, code: blocked ?? 'unknown_item' };
    const claim: Claim = { operatorId, itemId, cost: it.cost, at: now };
    this.claims.push(claim);
    let set = this.owned.get(operatorId);
    if (!set) this.owned.set(operatorId, (set = new Set()));
    set.add(itemId);
    return { ok: true, claim, wallet: this.wallet(operatorId) };
  }
}
