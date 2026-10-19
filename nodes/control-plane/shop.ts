/**
 * The hosts' shop: points earned by sharing a machine are spent on new cars and other items.
 * Rule from the project: new things are ONLY for people who share resources. There is no other way
 * to get a catalog item: it cannot be bought with money, won by playing or traded.
 *
 *   wallet    earned (ledger, all time) - spent (claims) = balance. Frozen while a node of the
 *             operator is under review for a failed verification (no claims meanwhile).
 *   catalog   items with a cost and a status: 'available' (claimable), 'soon' (announced, not
 *             claimable yet: the game does not have it), 'retired' (kept by owners, not claimable).
 *             Adding a car = adding its entry here once the game can draw it.
 *   inventory what an account owns; the game asks for it to unlock items (entitlements).
 *
 * Pure logic. Production keeps claims and inventories in the account's storage (docs/INTEGRACION.md).
 */
import type { Ledger } from './ledger';

export type ItemKind = 'car' | 'paint' | 'boost' | 'goal' | 'badge' | 'title';
export type ItemStatus = 'available' | 'soon' | 'retired';

export interface CatalogItem {
  id: string;
  kind: ItemKind;
  name: string;
  description: string;
  /** Points. */
  cost: number;
  status: ItemStatus;
  /** Verified hosted matches needed before the item can be claimed (the free badge needs one). */
  minVerifiedMatches?: number;
}

/**
 * Starting catalog. The cars and effects are placeholders ('soon') until the game has them: the
 * shop already shows what is coming, and nobody can claim what does not exist yet.
 */
export const CATALOG: readonly CatalogItem[] = [
  { id: 'badge-host', kind: 'badge', name: 'Anfitrión', description: 'Insignia en tu perfil y tu nombre en la pantalla de carga de las partidas de tu servidor.', cost: 0, status: 'available', minVerifiedMatches: 1 },
  { id: 'car-next-1', kind: 'car', name: 'Próximo auto', description: 'El primer auto nuevo del juego. Solo para anfitriones.', cost: 1500, status: 'soon' },
  { id: 'boost-next-1', kind: 'boost', name: 'Próxima estela de boost', description: 'Una estela exclusiva para anfitriones.', cost: 600, status: 'soon' },
  { id: 'goal-next-1', kind: 'goal', name: 'Próxima explosión de gol', description: 'Una explosión de gol exclusiva para anfitriones.', cost: 1000, status: 'soon' },
];

export interface Wallet {
  earned: number;
  spent: number;
  balance: number;
  /** Reason the wallet is frozen, or null. */
  frozen: string | null;
}

export interface Claim {
  operatorId: string;
  itemId: string;
  cost: number;
  at: number;
}

export type ClaimResult =
  | { ok: true; claim: Claim; wallet: Wallet }
  | { ok: false; code: 'unknown_item' | 'not_available' | 'owned' | 'frozen' | 'insufficient' | 'requires_matches' };

export interface ShopItemView extends CatalogItem {
  owned: boolean;
  claimable: boolean;
  /** Why it cannot be claimed now (when it cannot). */
  blocked?: Exclude<ClaimResult, { ok: true }>['code'];
}

function round2(x: number): number {
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
    if (!/^[a-z0-9-]{3,40}$/.test(item.id) || !(item.cost >= 0)) throw new Error('bad item');
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

  private check(operatorId: string, it: CatalogItem | undefined): Exclude<ClaimResult, { ok: true }>['code'] | null {
    if (!it) return 'unknown_item';
    if (this.owns(operatorId, it.id)) return 'owned';
    if (it.status !== 'available') return 'not_available';
    if (this.frozen.has(operatorId)) return 'frozen';
    if ((it.minVerifiedMatches ?? 0) > this.ledger.verifiedMatches(operatorId)) return 'requires_matches';
    if (this.wallet(operatorId).balance < it.cost) return 'insufficient';
    return null;
  }

  /** The catalog as this operator sees it (retired items only when owned). */
  view(operatorId: string): ShopItemView[] {
    const out: ShopItemView[] = [];
    for (const it of this.catalog.values()) {
      const owned = this.owns(operatorId, it.id);
      if (it.status === 'retired' && !owned) continue;
      const blocked = this.check(operatorId, it);
      out.push({ ...it, owned, claimable: blocked === null, ...(blocked && blocked !== 'owned' ? { blocked } : {}) });
    }
    return out.sort((a, b) => Number(a.status !== 'available') - Number(b.status !== 'available') || a.cost - b.cost);
  }

  claim(operatorId: string, itemId: string, now: number): ClaimResult {
    const it = this.catalog.get(itemId);
    const blocked = this.check(operatorId, it);
    if (blocked || !it) return { ok: false, code: blocked ?? 'unknown_item' };
    const claim: Claim = { operatorId, itemId, cost: it.cost, at: now };
    this.claims.push(claim);
    let set = this.owned.get(operatorId);
    if (!set) this.owned.set(operatorId, (set = new Set()));
    set.add(itemId);
    return { ok: true, claim, wallet: this.wallet(operatorId) };
  }
}
