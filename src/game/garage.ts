/**
 * The garage: the player's cars, the account's inventory and the hosts' shop as the menus show them
 * (src/ui/screens/garage.ts), and what keeps the player's car pick honest.
 *
 * Entitlement (carSelection.ts setEntitledCars): a guest drives the default car alone; a signed-in
 * account the default car and the car its session carries (AccountsDO signs only one the account
 * still owns) until GET /api/me/items, the shop or a claim answered for that account, then the
 * default car and every car the answer says it owns (the session's no longer counts by itself: a
 * car revoked since the session was signed is not driven). An account's pick follows the server's:
 * the session's car (or the items answer's, the fresher one) becomes the local pick, and equipping
 * goes through POST /api/me/car first (a re-signed session that carries it, AccountClient.selectCar),
 * so the car driven offline and the car seated online are the same one; the server is the authority
 * online. An answer that shows the session's car is stale (a maintainer's revoke, a pick in another
 * tab) re-signs the session through the refresh cookie (renewIfStale), so the next queue seats the
 * car the account drives now. A sign-out keeps the pick saved (it reads as the default car until
 * that account is back).
 *
 * The shop (GET /api/me/shop, nodes/docs/RECOMPENSAS.md): host points are earned only by running a
 * community server (verified player-minutes), never bought, won by playing or traded; a claim is one
 * server transaction (POST /api/me/shop/claim) and a car still to come ('soon', its body not built
 * yet: src/game/cosmetics.ts) cannot be claimed. A car is a body only (every one simulates as
 * CarPreset.Standard), so nothing here touches physics.
 *
 * garageView is the pure view model (tests/garage.test.mjs): each car's state and action, the card
 * on screen, the wallet and which explanation the screen owes the player (sign in, or how points are
 * earned). Nothing here runs per frame: every change comes from a menu action or an answer.
 */
import type { AccountSession } from '../net/account';
import type { ClaimAnswer, ItemsAnswer, ShopAnswer, ShopItemView, Wallet } from '../net/cosmetics';
import { setEntitledCars, type CarSelection } from './carSelection';
import { CARS, DEFAULT_CAR, isCarId, type CarCosmetic, type CarId } from './cosmetics';

/** What a car is to this player: driven now, owned, claimable now, out of reach, or still to come. */
export type GarageCarState = 'equipped' | 'owned' | 'claimable' | 'locked' | 'soon';

/** Why a locked car cannot be claimed: a guest has no wallet; else the shop's reason ('unknown' until it answers). */
export type GarageLock = 'guest' | 'insufficient' | 'frozen' | 'requires_matches' | 'not_available' | 'unknown';

export interface GarageCarView {
  readonly id: CarId;
  readonly nameKey: CarCosmetic['nameKey'];
  readonly descKey: CarCosmetic['descKey'];
  /** Host points (0: the default car, everyone's). */
  readonly price: number;
  readonly state: GarageCarState;
  /** Set when `state` is 'locked'. */
  readonly lock: GarageLock | null;
  /** Its body is built (status 'available'); false: it draws the default body for now, owned or not. */
  readonly bodyReady: boolean;
  /** The card on screen (the showroom shows this car). */
  readonly selected: boolean;
  /** What its button does: equip an owned car, claim a claimable one, nothing otherwise (a preview only). */
  readonly action: 'equip' | 'claim' | null;
}

export interface GarageView {
  /** Every car in menu order. */
  readonly cars: readonly GarageCarView[];
  /** The card on screen. */
  readonly selected: GarageCarView;
  /** The account's wallet; null for a guest, or until the shop answered. */
  readonly wallet: Wallet | null;
  /** What the screen explains: 'signIn' (a guest), 'host' (no points yet: how they are earned), null. */
  readonly explain: 'signIn' | 'host' | null;
}

export interface GarageInput {
  readonly signedIn: boolean;
  /** The car the player drives (Garage.equipped). */
  readonly equipped: CarId;
  /** The item ids the account owns (the default car is everyone's whether listed or not). */
  readonly owned: readonly string[];
  /** The account's shop answer, null for a guest or until it answers. */
  readonly shop: ShopAnswer | null;
  /** The card picked on screen, null = the equipped car's. */
  readonly selected: CarId | null;
  /** The catalog (src/game/cosmetics.ts CARS); tests pass their own. */
  readonly catalog?: readonly CarCosmetic[];
}

/**
 * Each car's state for this player (pure). Owned: the default car, an owned item id, or the shop's
 * own word. Still to come ('soon'): the catalog or the shop says so (a page and a server of
 * different builds both have to draw and sell it). A locked car tells why: a guest, else the shop's
 * reason. The explanation: a guest is asked to sign in; an account without a point to spend is told
 * how points are earned (never a rate: they come from verified hosted matches only).
 */
export function garageView(input: GarageInput): GarageView {
  const catalog = input.catalog ?? CARS;
  const shopCars = new Map<string, ShopItemView>();
  for (const it of input.shop?.items ?? []) if (it.kind === 'car') shopCars.set(it.id, it);
  const owns = (id: CarId) => id === DEFAULT_CAR || input.owned.includes(id) || shopCars.get(id)?.owned === true;
  // A car driven that is not owned (a revoke the session has not caught up with) shows as the default car: one card is always Equipped.
  const equipped = owns(input.equipped) ? input.equipped : DEFAULT_CAR;
  const pick = input.selected !== null && catalog.some((c) => c.id === input.selected) ? input.selected : equipped;
  const cars = catalog.map((c): GarageCarView => {
    const item = shopCars.get(c.id);
    const owned = owns(c.id);
    const soon = c.status !== 'available' || (item !== undefined && item.status !== 'available');
    let state: GarageCarState;
    let lock: GarageLock | null = null;
    if (owned) state = c.id === equipped ? 'equipped' : 'owned';
    else if (soon) state = 'soon';
    else if (item?.claimable === true) state = 'claimable';
    else {
      state = 'locked';
      lock = !input.signedIn ? 'guest' : input.shop === null ? 'unknown' : lockOf(item?.blocked);
    }
    return {
      id: c.id,
      nameKey: c.nameKey,
      descKey: c.descKey,
      // The shop's cost when it answered (the server claims at its own price), else the catalog's.
      price: item !== undefined ? item.cost : c.price,
      state,
      lock,
      bodyReady: c.status === 'available',
      selected: c.id === pick,
      action: state === 'owned' ? 'equip' : state === 'claimable' ? 'claim' : null,
    };
  });
  const wallet = input.signedIn ? (input.shop?.wallet ?? null) : null;
  const explain = !input.signedIn ? 'signIn' : wallet !== null && wallet.balance <= 0 ? 'host' : null;
  return { cars, selected: cars.find((c) => c.selected) ?? cars[0], wallet, explain };
}

/** A shop refusal as the garage tells it: an item the server does not list cannot be had now either. */
function lockOf(blocked: ShopItemView['blocked']): GarageLock {
  return blocked === undefined || blocked === 'unknown_item' ? 'not_available' : blocked;
}

/**
 * Where the garage's showroom puts the car: the part of the screen its panels leave free, as
 * fractions of the viewport from the top left (CSS order). Game.enterShowroom fits the car there.
 */
export interface ShowroomFrame {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** What the garage needs of the accounts (AccountClient; tests fake it). */
export interface GarageAccounts {
  readonly account: AccountSession | null;
  subscribe(fn: () => void): () => void;
  fetchItems(): Promise<ItemsAnswer>;
  fetchShop(): Promise<ShopAnswer>;
  selectCar(car: CarId): Promise<AccountSession>;
  claimItem(item: string): Promise<ClaimAnswer>;
  /** Re-sign the session through the refresh cookie (AccountClient.renewSession): it then carries the car driven now. */
  renewSession(): Promise<unknown>;
}

export class Garage {
  /** The account's shop as it last answered (refresh), null for a guest or before the first. */
  shop: ShopAnswer | null = null;
  /** A shop read is in flight (the screen says so). */
  loading = false;
  /** The last shop read failed: the player's text (AccountError's), null otherwise. */
  error: string | null = null;

  private readonly accounts: GarageAccounts;
  private readonly pick: CarSelection;
  private readonly onCarChange: () => void;
  /** Whose `items` they are (the account they were read for), null for a guest. */
  private owner: string | null = null;
  /** The item ids `owner` owns (items or shop answers); [] until one answered. */
  private items: readonly string[] = [];
  /** An answer (items, the shop, a claim) came for `owner`: `items` alone entitle, the session's car no longer by itself. */
  private answered = false;
  /** The session (owner and token) a renewal was asked for (renewIfStale): one stale session renews once. */
  private renewed: string | null = null;
  private readonly listeners = new Set<() => void>();

  /**
   * `pick` is the Game's (Game.carPick); `onCarChange` runs whenever the car the player drives may
   * be another one (the Game dresses the player's car in place).
   */
  constructor(accounts: GarageAccounts, pick: CarSelection, onCarChange: () => void = () => undefined) {
    this.accounts = accounts;
    this.pick = pick;
    this.onCarChange = onCarChange;
    accounts.subscribe(() => this.onAccount());
    this.onAccount();
  }

  get signedIn(): boolean {
    return this.accounts.account !== null;
  }

  /** The car the player drives now: offline, and online from the next match (the pick, as entitled). */
  get equipped(): CarId {
    return this.pick.current;
  }

  /** The item ids the signed-in account owns, as far as an answer said ([] for a guest). */
  get owned(): readonly string[] {
    return this.items;
  }

  /** The view model with card `selected` on screen (null: the equipped car's). */
  view(selected: CarId | null): GarageView {
    return garageView({ signedIn: this.signedIn, equipped: this.equipped, owned: this.items, shop: this.shop, selected });
  }

  /** Call `fn` after every change (an answer, a claim, a sign-in or out); returns the unsubscribe. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch (err) {
        console.error('[garage] listener failed', err);
      }
    }
  }

  /** Sign-in, sign-out, a fresh session (a refresh, a car picked): another account starts from nothing and reads its items. */
  private onAccount(): void {
    const id = this.accounts.account?.playerId ?? null;
    if (id !== this.owner) {
      this.owner = id;
      this.items = [];
      this.answered = false;
      this.renewed = null;
      this.shop = null;
      this.error = null;
      this.loading = false;
      if (id !== null) void this.loadItems(id);
    }
    this.sync(this.accounts.account?.car);
  }

  /**
   * The entitlement from the session and the items known, then the server's car (`car`: the
   * session's, or a fresher answer's) as the pick; the Game hears of a car change.
   */
  private sync(car: CarId | undefined): void {
    const a = this.accounts.account;
    const before = this.pick.current;
    setEntitledCars(a === null ? [] : this.answered ? this.items : [a.car ?? DEFAULT_CAR, ...this.items]);
    // An older server sends no car: the pick stays (as entitled).
    if (a !== null && car !== undefined && this.pick.current !== car) this.pick.select(car);
    if (this.pick.current !== before) this.onCarChange();
    this.changed();
  }

  /**
   * An answer for the signed-in account shows its session's car is not the one it drives now
   * (`car`: the items answer's, which says which one; undefined after a shop answer, where the
   * session's car is stale when it is no longer owned): a maintainer revoked it, or another tab
   * picked another. The session is re-signed through the refresh cookie (AccountsDO signs the car
   * driven now), or every queue until it expires (up to an hour) would seat the old car online while
   * the garage shows another. Once per session; a session without a car (an older server) never.
   */
  private renewIfStale(car: CarId | undefined): void {
    const a = this.accounts.account;
    if (a === null || a.car === undefined || a.playerId !== this.owner) return;
    const stale = car !== undefined ? car !== a.car : a.car !== DEFAULT_CAR && !this.items.includes(a.car);
    const key = a.playerId + ' ' + a.session;
    if (!stale || this.renewed === key) return;
    this.renewed = key;
    this.accounts.renewSession().catch(() => undefined); // adopted: onAccount -> sync moves the pick
  }

  /** GET /api/me/items for `owner` (a sign-in): every car it owns counts offline too. Failing is quiet: the session's car still counts. */
  private async loadItems(owner: string): Promise<void> {
    let r: ItemsAnswer;
    try {
      r = await this.accounts.fetchItems();
    } catch {
      return; // offline, or a server from before the inventory
    }
    if (this.owner !== owner) return;
    this.items = r.items;
    this.answered = true;
    this.renewIfStale(r.car);
    this.sync(r.car);
  }

  /** Read the account's shop (the garage opened): its cars, what can be claimed and the wallet. A guest reads nothing. */
  async refresh(): Promise<void> {
    const owner = this.owner;
    if (owner === null) return;
    this.loading = true;
    this.changed();
    try {
      const shop = await this.accounts.fetchShop();
      if (this.owner !== owner) return;
      this.shop = shop;
      this.error = null;
      this.items = shop.items.filter((it) => it.owned).map((it) => it.id);
      this.answered = true;
      this.renewIfStale(undefined);
    } catch (err) {
      if (this.owner === owner) this.error = err instanceof Error ? err.message : String(err);
    } finally {
      if (this.owner === owner) {
        this.loading = false;
        this.sync(undefined);
      }
    }
  }

  /**
   * Drive car `id` from now on: an account through POST /api/me/car first (the server keeps the
   * pick and seats the account with it from the next match; the adopted session moves the local
   * pick, see sync), a guest the default car only. Resolves whether the car is the one driven now;
   * rejects with the server's refusal (AccountError, its text the player's), changing nothing.
   */
  async equip(id: CarId): Promise<boolean> {
    if (!isCarId(id)) return false;
    if (this.accounts.account !== null) {
      await this.accounts.selectCar(id); // adopted: onAccount -> sync moves the pick to the session's car
      return this.pick.current === id;
    }
    const before = this.pick.current;
    const ok = this.pick.select(id);
    if (this.pick.current !== before) this.onCarChange();
    this.changed();
    return ok;
  }

  /**
   * Claim car `id` with the account's host points (one server transaction; nothing is spent twice).
   * The answer's items and wallet count at once; the shop is read again behind it (what is
   * claimable moves with the balance). Rejects with the refusal (AccountError: not_available,
   * frozen, insufficient, requires_matches...) or for a guest.
   */
  async claim(id: CarId): Promise<ClaimAnswer> {
    const owner = this.owner;
    if (owner === null) throw new Error('garage: a guest cannot claim');
    const r = await this.accounts.claimItem(id);
    if (this.owner !== owner) return r;
    this.items = r.items;
    this.answered = true;
    if (this.shop !== null) {
      // The claimed item is owned now (no longer claimable, nothing blocks it) until the shop answers again.
      const items = this.shop.items.map((it): ShopItemView => {
        if (it.id !== r.item) return it;
        const { blocked: _blocked, ...rest } = it;
        return { ...rest, owned: true, claimable: false };
      });
      this.shop = { items, wallet: r.wallet };
    }
    this.sync(undefined);
    void this.refresh();
    return r;
  }
}
