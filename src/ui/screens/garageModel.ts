/**
 * GARAJE's decisions (src/ui/screens/garage.ts, plan §1.4.2 and PR 8), pure: what a car's row says,
 * what the detail card's button is and what pressing it does, the points card, whether GANA PUNTOS
 * is the lime card and the redeem sheet's balance line. Everything reads src/game/garage.ts's view
 * model (garageView) and hands back locale keys with their params; the screen writes them
 * (tests/garage-screen.test.mjs).
 *
 * The rule the screen keeps (nodes/docs/RECOMPENSAS.md): server points come only from hosting a
 * community server, nothing is paid. So a car out of reach still shows CANJEAR, never lime, with the
 * reason beside it, and its press explains: a guest is sent to sign in, an account without the
 * points to the guide (how a server is hosted), a paused account to PERFIL's MI SERVIDOR.
 */
import type { GarageCarView, GarageView } from '../../game/garage';
import type { Key } from '../../i18n';

/** A text as a locale key and its params (numbers formatted by the screen: formatPoints). */
export interface Line {
  readonly key: Key;
  readonly params?: Readonly<Record<string, number>>;
}

/** How long the focus rests on a row before its car is put in the showroom (plan §1.4.2). */
export const PREVIEW_MS = 300;

/** How long MANTÉN PARA CONFIRMAR is held to redeem (plan §1.7). */
export const REDEEM_HOLD_MS = 700;

/** A row's state line: "Equipado · Gratis", "Tuyo", "Canjeable · 1.500 pts", "Bloqueado · 1.500 pts", "Próximamente". */
export function rowLine(c: GarageCarView): Line {
  switch (c.state) {
    case 'equipped':
      return { key: c.price === 0 ? 'garage.stateEquippedFree' : 'garage.stateEquipped' };
    case 'owned':
      return { key: 'garage.stateOwned' };
    case 'claimable':
      return { key: 'garage.stateClaimable', params: { points: c.price } };
    case 'locked':
      return { key: 'garage.stateLocked', params: { points: c.price } };
    default:
      return { key: 'garage.stateSoon' };
  }
}

/** What the detail's button does when pressed: the car's own action, or where the explanation is. */
export type DetailPress = 'equip' | 'redeem' | 'signIn' | 'earn' | 'profile' | null;

export interface DetailView {
  /** The button: EQUIPAR, CANJEAR POR {points} PTS, or none (the car driven, one still to come). */
  readonly button: 'equip' | 'redeem' | null;
  /** The lime look: only when the press does what the button says. */
  readonly lime: boolean;
  readonly press: DetailPress;
  /** The line under it (why it cannot be had, or that it is driven), null when the button says it all. */
  readonly reason: Line | null;
  /** A paused account's line is --warn; a lock's line takes the lock icon. */
  readonly tone: 'plain' | 'lock' | 'warn';
}

/** The detail card of the car on screen (`c`) for the player of view `v`. */
export function detailView(c: GarageCarView, v: GarageView): DetailView {
  switch (c.state) {
    case 'equipped':
      return { button: null, lime: false, press: null, reason: { key: 'garage.inUse' }, tone: 'plain' };
    case 'owned':
      return { button: 'equip', lime: true, press: 'equip', reason: null, tone: 'plain' };
    case 'claimable':
      return { button: 'redeem', lime: true, press: 'redeem', reason: null, tone: 'plain' };
    case 'soon':
      return { button: null, lime: false, press: null, reason: { key: 'garage.soonText' }, tone: 'plain' };
    default:
      break;
  }
  const have = Math.max(0, Math.floor(v.wallet?.balance ?? 0));
  const locked = (press: DetailPress, reason: Line, tone: DetailView['tone'] = 'lock'): DetailView => ({ button: 'redeem', lime: false, press, reason, tone });
  switch (c.lock) {
    case 'guest':
      return locked('signIn', { key: 'garage.needSignIn' });
    case 'insufficient':
      return locked('earn', { key: 'garage.missing', params: { have, missing: Math.max(0, c.price - have) } });
    case 'frozen':
      return locked('profile', { key: 'garage.needFrozen' }, 'warn');
    case 'requires_matches':
      return locked('earn', { key: 'garage.needMatches' });
    case 'unknown':
      return locked(null, { key: 'garage.needLoading' }, 'plain');
    default:
      return locked(null, { key: 'garage.needUnavailable' });
  }
}

export interface PointsCard {
  /** 'guest': 0 and SIGN IN; 'account': the balance; 'loading' / 'error': the shop has not answered; 'preview': a preview build's guest. */
  readonly kind: 'guest' | 'account' | 'loading' | 'error' | 'preview';
  readonly points: number;
  /** The account's claims are paused (a maintainer's review): the --warn line. */
  readonly paused: boolean;
}

/** The PUNTOS DE SERVIDOR card (and the bar's pill): a guest has 0; an account its wallet once the shop answered. */
export function pointsCard(v: GarageView, s: { readonly signedIn: boolean; readonly loading: boolean; readonly error: string | null }): PointsCard {
  if (v.preview) return { kind: 'preview', points: 0, paused: false };
  if (!s.signedIn) return { kind: 'guest', points: 0, paused: false };
  const w = v.wallet;
  if (w !== null) return { kind: 'account', points: Math.max(0, Math.floor(w.balance)), paused: w.frozen !== null };
  return { kind: s.error !== null && !s.loading ? 'error' : 'loading', points: 0, paused: false };
}

/** GANA PUNTOS… is the lime card unless a car can be redeemed now (then CANJEAR is the one lime action). */
export function earnIsLime(v: GarageView): boolean {
  return !v.cars.some((c) => c.state === 'claimable');
}

/** The redeem sheet's "Saldo: 2.100 → 600": the balance before and after, never below 0. */
export function redeemBalance(price: number, balance: number): { readonly from: number; readonly to: number } {
  const from = Math.max(0, Math.floor(balance));
  return { from, to: Math.max(0, from - price) };
}
