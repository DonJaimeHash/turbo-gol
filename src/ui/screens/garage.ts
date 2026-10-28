/**
 * GARAJE, the section's root (plan §1.4.2): the cars, the one the player drives and the hosts'
 * shop, over the showroom camera (MenuHost.garage.showroom: the player's car orbiting in the part of
 * the screen the panels leave free, `.mn-garage-stage`, measured on show and on every layout change,
 * never per frame; the menus go see-through meanwhile, `mn-see-through`). The cars' first styling
 * (styles/screens/garage.css), a working stub until PR 8 redraws it to the owner's drawings: the
 * screen only draws src/game/garage.ts's view model (garageView), so another look redraws this file
 * alone.
 *
 * A card per car, in menu order: its name and state (equipped, owned, claimable or locked with its
 * price in host points, coming soon). Focusing or clicking a card puts that car in the showroom
 * (any car, owned or not: a look, never the car driven; Game.previewCar) with its line and its
 * action: EQUIP an owned car (Garage.equip: the server first for an account, so its next seats
 * drive it), CLAIM a claimable one (a confirm modal, then Garage.claim: one server transaction), or
 * why it cannot be had. The side panel: the account's host points (balance, earned and spent, a
 * freeze and why) and what the player is owed: a guest is asked to sign in, and a guest or an
 * account without points to spend is told they come only from running a community server (the
 * nodes' docs, Discord). Never a rate: points come from verified matches, weighted by the players
 * and the region (nodes/docs/RECOMPENSAS.md).
 *
 * Keyboard / controller: the cards and buttons are data-nav targets, the equipped car's card is
 * focused first and moving onto a card looks at it; touch: a tap on a card picks it.
 *
 * A preview build (VITE_PREVIEW_CARS=1, carSelection.ts PREVIEW_ALL_CARS): a guest owns every car
 * and the side panel says so in place of the invitation to sign in (garage.ts previewNotice).
 */
import { h, navButton, setChildren } from '../dom';
import type { Child } from '../dom';
import { language, t } from '../../i18n';
import { carDescription, carName } from '../names';
import type { Menu, Screen } from '../Menu';
import { CARS, type CarId } from '../../game/cosmetics';
import { previewNotice, type Garage, type GarageCarView, type GarageView, type ShowroomFrame } from '../../game/garage';
import { PREVIEW_ALL_CARS } from '../../game/carSelection';
import { DISCORD_URL, SOURCE_URL } from '../../brand';
import { screenHead } from './common';

/** Host points as the page's language writes them, grouped from the thousands (1,500 / 1.500), whole points only. */
export function formatPoints(n: number): string {
  // 'always': Spanish groups four-digit numbers too (1.500, as the shop's prices are written).
  const opts = { useGrouping: 'always', maximumFractionDigits: 0 } as unknown as Intl.NumberFormatOptions;
  return new Intl.NumberFormat(language(), opts).format(Math.max(0, Math.floor(n)));
}

/** How a community server is run (the nodes' README, in the page's language when there is one). */
function hostingDocsUrl(): string {
  return SOURCE_URL + (language() === 'es' ? '/blob/main/nodes/README.es.md' : '/blob/main/nodes/README.md');
}

/** The whole screen: where the showroom fits the car when the stage has no room of its own. */
const FULL_FRAME: ShowroomFrame = { x0: 0, y0: 0, x1: 1, y1: 1 };

/** A car card's state line. */
function stateText(c: GarageCarView): string {
  switch (c.state) {
    case 'equipped':
      return t('garage.stateEquipped');
    case 'owned':
      return t('garage.stateOwned');
    case 'claimable':
      return t('garage.stateClaimable', { points: formatPoints(c.price) });
    case 'locked':
      return t('garage.stateLocked', { points: formatPoints(c.price) });
    default:
      return t('garage.stateSoon');
  }
}

/** The line under the car on screen: what it is to the player, or why it cannot be had. */
function needText(c: GarageCarView, v: GarageView): string {
  switch (c.state) {
    case 'equipped':
      return c.bodyReady ? t('garage.equippedNow') : t('garage.bodySoon');
    case 'owned':
      return c.bodyReady ? '' : t('garage.bodySoon');
    case 'claimable':
      return '';
    case 'soon':
      return t('garage.soonText');
    default:
      break;
  }
  switch (c.lock) {
    case 'guest':
      return t('garage.needSignIn');
    case 'insufficient':
      return t('garage.needPoints', { cost: formatPoints(c.price), balance: formatPoints(v.wallet?.balance ?? 0) });
    case 'frozen':
      return t('garage.needFrozen');
    case 'requires_matches':
      return t('garage.needMatches');
    case 'unknown':
      return t('garage.needLoading');
    default:
      return t('garage.needUnavailable');
  }
}

/** A refusal or a failure as the player reads it (AccountError carries the player's text already). */
function errorText(err: unknown): string {
  return err instanceof Error && err.message.length > 0 ? err.message : t('error.unexpected');
}

/** A link styled as a small button, a controller target (it opens a new tab). */
function linkButton(label: string, href: string): HTMLAnchorElement {
  return h('a.mn-btn.mn-btn-small.mn-garage-link', { href, target: '_blank', rel: 'noopener', 'data-nav': true }, label);
}

export function garageScreen(menu: Menu): Screen {
  const store = (): Garage => menu.host.garage.store;
  /** The card picked on screen, null = the equipped car's (each show starts there). */
  let selected: CarId | null = null;
  /** An equip is on its way (the button waits). */
  let busy = false;
  let shown = false;
  let unsubscribe: (() => void) | null = null;

  const cards = new Map<CarId, { btn: HTMLButtonElement; state: HTMLElement }>();
  const pick = (id: CarId): void => {
    if (selected === id && shown) return;
    selected = id;
    render();
  };
  for (const c of CARS) {
    const state = h('span.mn-garage-state');
    const btn = navButton('mn-garage-car', [h('span.mn-garage-car-name', null, carName(c.id)), state], () => pick(c.id));
    // The keyboard and the controller look at a car by moving onto it.
    btn.addEventListener('focus', () => pick(c.id));
    cards.set(c.id, { btn, state });
  }

  const name = h('div.mn-garage-name');
  const previewTag = h('span.mn-tag.mn-garage-tag', null, t('garage.previewTag'));
  const desc = h('div.mn-garage-desc');
  const need = h('div.mn-garage-need');
  const action = navButton('mn-btn mn-btn-primary mn-garage-action', '', () => act());
  const detail = h('div.mn-garage-detail', null, h('div.mn-garage-name-row', null, name, previewTag), desc, need, action);
  // The showroom fits the car into this box (frame()): the screen's see-through middle.
  const stage = h('div.mn-garage-stage');
  const wallet = h('section.mn-section.mn-garage-wallet');
  const explain = h('section.mn-section.mn-garage-explain');
  const el = h(
    'div.mn-garage',
    null,
    h('div.mn-garage-view', null, screenHead(t('garage.heading'), t('garage.subtitle')), stage, detail),
    // The points (or a guest's invitation) on top, the cars, then how points are earned.
    h('aside.mn-garage-side', null, wallet, h('div.mn-garage-cars', null, ...[...cards.values()].map((c) => c.btn)), explain),
  );

  /** Rebuild `box` only when what it shows changed (`key`): a focused button inside it keeps the focus. */
  const draw = (box: HTMLElement, key: string, build: () => Child[]): void => {
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    setChildren(box, ...build());
  };

  const drawWallet = (v: GarageView): void => {
    const g = store();
    // A preview build: every car is the guest's (nothing to sign in for). A production build drops this branch and its text.
    if (PREVIEW_ALL_CARS && v.preview) {
      draw(wallet, 'preview:' + language(), () => [h('h2.mn-section-title', null, previewNotice(language()))]);
      return;
    }
    if (!g.signedIn) {
      draw(wallet, 'guest', () => [
        h('h2.mn-section-title', null, t('garage.guestTitle')),
        h('p.mn-garage-text', null, t('garage.guestText')),
        navButton('mn-btn mn-btn-primary', t('profile.signIn'), () => menu.open('profile')),
      ]);
      return;
    }
    const w = v.wallet;
    if (w !== null) {
      const frozen = w.frozen === null ? '' : w.frozen.startsWith('verification_failed') ? t('garage.frozenVerification') : t('garage.frozen');
      draw(wallet, `w:${w.balance}:${w.earned}:${w.spent}:${frozen}`, () => [
        h('h2.mn-section-title', null, t('garage.wallet')),
        h('div.mn-garage-balance', null, t('garage.points', { points: formatPoints(w.balance) })),
        h('div.mn-garage-sub', null, t('garage.earnedSpent', { earned: formatPoints(w.earned), spent: formatPoints(w.spent) })),
        frozen ? h('p.mn-garage-frozen', null, frozen) : null,
      ]);
    } else if (g.error !== null && !g.loading) {
      const error = g.error;
      draw(wallet, 'e:' + error, () => [h('h2.mn-section-title', null, t('garage.wallet')), h('p.mn-garage-frozen', null, error), navButton('mn-btn mn-btn-small', t('garage.retry'), () => void store().refresh())]);
    } else {
      draw(wallet, 'loading', () => [h('h2.mn-section-title', null, t('garage.wallet')), h('p.mn-garage-sub', null, t('garage.loading'))]);
    }
  };

  const drawExplain = (v: GarageView): void => {
    explain.hidden = v.explain === null;
    if (v.explain === null) return;
    draw(explain, 'host', () => [
      h('h2.mn-section-title', null, t('garage.hostTitle')),
      h('p.mn-garage-text', null, t('garage.hostText')),
      h('p.mn-garage-text', null, t('garage.hostTesting')),
      h('div.mn-garage-links', null, linkButton(t('garage.hostDocs'), hostingDocsUrl()), linkButton(t('garage.hostDiscord'), DISCORD_URL)),
    ]);
  };

  function render(): void {
    const g = store();
    const v = g.view(selected);
    for (const c of v.cars) {
      const card = cards.get(c.id);
      if (card === undefined) continue;
      card.btn.dataset.state = c.state;
      card.btn.classList.toggle('mn-garage-car-on', c.selected);
      card.btn.toggleAttribute('data-autofocus', c.state === 'equipped');
      card.btn.setAttribute('aria-pressed', c.selected ? 'true' : 'false');
      card.state.textContent = stateText(c);
    }
    const s = v.selected;
    name.textContent = carName(s.id);
    desc.textContent = carDescription(s.id);
    previewTag.hidden = s.state === 'equipped';
    need.textContent = needText(s, v);
    need.hidden = need.textContent === '';
    action.hidden = s.action === null;
    action.textContent = s.action === 'claim' ? t('garage.claim', { points: formatPoints(s.price) }) : t('garage.equip');
    action.disabled = busy;
    drawWallet(v);
    drawExplain(v);
    // The car on screen: a look at the one picked, or the one driven (no preview).
    if (shown) menu.host.garage.preview(s.state === 'equipped' ? null : s.id);
  }

  const confirmClaim = (c: GarageCarView): void => {
    const g = store();
    const balance = g.shop?.wallet.balance ?? 0;
    const car = carName(c.id);
    menu.modal({
      title: t('garage.claimTitle', { car }),
      body: h('p', null, t('garage.claimText', { car, cost: formatPoints(c.price), balance: formatPoints(balance), after: formatPoints(balance - c.price) })),
      // Cancel first: the focus starts on it, so a stray A press spends nothing.
      actions: [
        { label: t('garage.claimCancel'), onClick: () => true },
        {
          label: t('garage.claimConfirm'),
          primary: true,
          onClick: async () => {
            try {
              await g.claim(c.id);
              menu.toast(t('garage.claimed', { car }), 'ok');
            } catch (err) {
              menu.toast(errorText(err), 'error');
            }
          },
        },
      ],
    });
  };

  const act = (): void => {
    const g = store();
    const c = g.view(selected).selected;
    if (busy || c.action === null) return;
    if (c.action === 'claim') {
      confirmClaim(c);
      return;
    }
    busy = true;
    render();
    void g
      .equip(c.id)
      .then(
        (ok) => {
          if (ok) menu.toast(t('garage.equipped', { car: carName(c.id) }), 'ok');
        },
        (err: unknown) => menu.toast(errorText(err), 'error'),
      )
      .finally(() => {
        busy = false;
        if (shown) render();
      });
  };

  /** The stage's box as viewport fractions (CSS order), the whole screen when it has no room. */
  const frame = (): ShowroomFrame => {
    const r = stage.getBoundingClientRect();
    const w = window.innerWidth;
    const hh = window.innerHeight;
    if (r.width < 24 || r.height < 24 || w <= 0 || hh <= 0) return FULL_FRAME;
    return { x0: r.left / w, y0: r.top / hh, x1: r.right / w, y1: r.bottom / hh };
  };
  const place = (): void => {
    if (shown) menu.host.garage.showroom(frame());
  };
  // A layout change (a resize, a phone turned, the side panel growing) fits the car again.
  const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null;

  return {
    id: 'garage',
    title: t('nav.garage'),
    el,
    show: () => {
      shown = true;
      selected = null;
      menu.root.classList.add('mn-see-through');
      unsubscribe?.();
      unsubscribe = store().subscribe(() => {
        if (shown) render();
      });
      render();
      place();
      resized?.observe(stage);
      window.addEventListener('resize', place);
      // The account's cars, what it can claim and its points (a guest reads nothing).
      void store().refresh();
    },
    hide: () => {
      shown = false;
      unsubscribe?.();
      unsubscribe = null;
      resized?.disconnect();
      window.removeEventListener('resize', place);
      menu.root.classList.remove('mn-see-through');
      // The camera back to the menus, the player's own body back on its car.
      menu.host.garage.showroom(null);
    },
  };
}
