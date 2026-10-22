/**
 * The cosmetic cars (the garage, the host points shop): every car id in menu order, its name and
 * one-line description (locale keys: src/ui/names.ts carName / carDescription), its price in host
 * points and whether it can be had yet. Pure data with no imports: the Worker's shop can read the
 * same table later (nodes/control-plane/shop.ts still lists a placeholder), and no file of the
 * community nodes' bundle may import this module at runtime (tests/cosmetics.test.mjs), so adding
 * a car never needs a node release.
 *
 * Every car is cosmetic: the same hitbox, wheels and physics (CarPreset.Standard) for all, ranked
 * or not. The bodies are in src/render/cars (docs/cars.md); a car whose body is not built yet
 * draws the default car. Names are invented, Spanish words of the pampas and the Andes (the
 * pampero wind, the capybara, the condor, the southern lapwing): no commercial car or game.
 */

export type CarId = 'dune' | 'pampero' | 'carpincho' | 'condor' | 'tero';

/** Every car, in menu order. */
export const CAR_IDS: readonly CarId[] = ['dune', 'pampero', 'carpincho', 'condor', 'tero'];

/** The default car: free for everyone, every bot drives it, every car online for now. */
export const DEFAULT_CAR: CarId = 'dune';

/** 'available': it can be owned and driven; 'soon': listed, its body is still to come. */
export type CarStatus = 'available' | 'soon';

/** Price in host points (the shop's one table; the default car is free). */
export const CAR_PRICES: Readonly<Record<CarId, number>> = {
  dune: 0,
  pampero: 1500,
  carpincho: 1500,
  condor: 1500,
  tero: 1500,
};

/**
 * 'available' exactly when the car's body module (src/render/cars/<id>.ts) has a body
 * (tests/cosmetics.test.mjs). One car per paragraph: the bodies are built on parallel branches,
 * and git merges two edits cleanly only with an unchanged line between them.
 */
const CAR_STATUS: Readonly<Record<CarId, CarStatus>> = {
  dune: 'available',

  pampero: 'soon',

  carpincho: 'soon',

  condor: 'available',

  tero: 'soon',
};

export interface CarCosmetic {
  readonly id: CarId;
  /** Locale keys of the display name and of the one-line description. */
  readonly nameKey: `car.${CarId}`;
  readonly descKey: `car.${CarId}Desc`;
  /** Host points (0: free). */
  readonly price: number;
  readonly status: CarStatus;
}

/** The catalog, in menu order. */
export const CARS: readonly CarCosmetic[] = CAR_IDS.map((id) => ({
  id,
  nameKey: `car.${id}` as const,
  descKey: `car.${id}Desc` as const,
  price: CAR_PRICES[id],
  status: CAR_STATUS[id],
}));

export function isCarId(v: unknown): v is CarId {
  return typeof v === 'string' && (CAR_IDS as readonly string[]).includes(v);
}

/** The catalog entry of `id`. */
export function carCosmetic(id: CarId): CarCosmetic {
  return CARS[CAR_IDS.indexOf(id)];
}
