/**
 * GARAJE, the section's root (plan §1.4.2 and PR 8; the owner's drawing hub-garaje-pc), over the
 * showroom camera (MenuHost.garage.showroom: the player's car turning in the stage the columns leave
 * free, `.mn-gar-stage`, measured on show and on every layout change, never per frame; the shell's
 * backdrop steps aside there, styles/screens/garage.css). The screen draws src/game/garage.ts's
 * view model through garageModel.ts (pure: the rows' lines, the detail's button and reason, the
 * points card).
 *
 * Left: TU AUTO (the car driven, its line, "Gratis para todos" for the free one), PUNTOS DE
 * SERVIDOR (the balance; a guest's 0 and SIGN IN, which opens PERFIL as a detour, Menu.open: Back
 * or a sign-in comes back here; a paused account's --warn line) and GANA PUNTOS ALOJANDO UN SERVIDOR COMUNITARIO (the
 * hosting guide: a new tab with a mouse, a keyboard or a finger; with a controller, a remote or on
 * a TV a sheet with its QR). Right: the tabs AUTOS │ ESTADIOS (`.mn-tabs`: Q / E, LT / RT, CH± /
 * PgUp / PgDn step them, Menu.stepTabs; focus = selection), the list (a row per car with its
 * outline, components/carRow.ts; or the three stadiums) and the detail card: the car's name and
 * price, its action and why it cannot be had.
 *
 * A row: the focus picks it (its car in the showroom once the focus rested PREVIEW_MS, a look
 * only, never the car driven: Game.previewCar); a click or a tap picks it at once; A / Enter / OK
 * on the row picked goes to its action. EQUIPAR: Garage.equip (an account through POST
 * /api/me/car, so its next seats drive it). CANJEAR (a car that can be redeemed): the sheet with
 * the balance after it, CANCELAR focused and MANTÉN PARA CONFIRMAR held REDEEM_HOLD_MS
 * (components/hold.ts) → Garage.claim (one server transaction) → "Pampero es tuyo" with EQUIPAR
 * AHORA; a failure spends nothing and offers REINTENTAR. A car out of reach keeps CANJEAR, never
 * lime, with the reason; its press explains (sign in, the guide, PERFIL's MI SERVIDOR). Points come
 * only from hosting (nodes/docs/RECOMPENSAS.md): never a rate, nothing is paid.
 *
 * ESTADIOS: the stadiums that exist, the one in use marked, as MODOS' stadium sheet lists them
 * (components/stadium.ts stadiumOptions); USAR applies one behind the loading screen
 * (chooseStadium: MenuHost.setTheme), the one in use has none.
 *
 * A preview build (VITE_PREVIEW_CARS=1, carSelection.ts PREVIEW_ALL_CARS): a guest owns every car
 * and the points card says so (garage.ts previewNotice). In development (or a VITE_UI_FIT=1 build)
 * window.__garage(kind | null) shows an account's samples (scripts/ui-fit.mjs).
 */
import { h, setChildren } from '../dom';
import type { Child } from '../dom';
import { language, t } from '../../i18n';
import type { Params } from '../../i18n';
import { carDescription, carName, formatPoints, themeName } from '../names';
import type { Menu, Screen } from '../Menu';
import { CARS, type CarId } from '../../game/cosmetics';
import { garageView, previewNotice, type GarageCarView, type GarageView, type ShowroomFrame } from '../../game/garage';
import type { ShopAnswer } from '../../net/cosmetics';
import { PREVIEW_ALL_CARS } from '../../game/carSelection';
import type { ThemeId } from '../../render/theme';
import { SOURCE_URL } from '../../brand';
import { icon } from '../components/icons';
import { glyph } from '../components/glyphs';
import { onNavSide } from '../nav';
import { qrSvg } from '../components/qr';
import { carSilhouette } from '../components/carSilhouettes';
import { garageRow, type GarageRow } from '../components/carRow';
import { chooseStadium, stadiumOptions } from '../components/stadium';
import { detailView, earnIsLime, pointsCard, PREVIEW_MS, REDEEM_HOLD_MS, redeemBalance, rowLine, type Line } from './garageModel';

/** How a community server is hosted (the nodes' README, in the page's language when there is one). */
function guideUrl(): string {
  return SOURCE_URL + (language() === 'es' ? '/blob/main/nodes/README.es.md' : '/blob/main/nodes/README.md');
}

/** The whole screen: where the showroom fits the car when the stage has no room of its own. */
const FULL_FRAME: ShowroomFrame = { x0: 0, y0: 0, x1: 1, y1: 1 };

/** What a car costs at most (the catalog's): GANA PUNTOS' "CADA AUTO · 1.500 PTS". */
const EACH_CAR = Math.max(...CARS.map((c) => c.price));

type Tab = 'cars' | 'stadiums';

/** A sample for the layout check (window.__garage): an account and its shop answer. */
type SampleKind = 'account' | 'points' | 'owned' | 'paused' | 'stadiums' | 'redeem' | 'guide';

/** A refusal or a failure as the player reads it (AccountError carries the player's text already). */
function errorText(err: unknown): string {
  return err instanceof Error && err.message.length > 0 ? err.message : t('error.unexpected');
}

/** A Line's text, its numbers as points. */
function lineText(l: Line): string {
  const params: Params = {};
  for (const [k, v] of Object.entries(l.params ?? {})) params[k] = formatPoints(v);
  return t(l.key, params);
}

/** "1.500 PTS" with the points glyph. */
function price(n: number): Child[] {
  return [icon('points', 'mn-gar-pts-icon'), h('b.mn-gar-pts-num', null, formatPoints(n)), h('span.mn-gar-pts-unit', null, t('garage.pts'))];
}

export function garageScreen(menu: Menu): Screen {
  const host = menu.host;
  const html = document.documentElement;
  const tv = (): boolean => html.classList.contains('tg-tv');
  let tab: Tab = 'cars';
  /** The row picked on screen, null = the equipped car's (each show starts there). */
  let selected: CarId | null = null;
  let stadium: ThemeId = host.theme;
  /** An equip is on its way (the button waits). */
  let busy = false;
  let shown = false;
  let unsubscribe: (() => void) | null = null;
  let previewTimer = 0;
  /** The body the showroom shows (previewCar), null = the car driven. */
  let previewed: CarId | null = null;
  /** SIGN IN opened PERFIL: a sign-in there comes back here (the return with intent). */
  let waitSignIn = false;
  let sample: { kind: SampleKind; shop: ShopAnswer; owned: string[] } | null = null;
  /** The redeem or guide sheet up (Menu.modal's close), for a sample switched under it. */
  let closeSheet: (() => void) | null = null;

  const store = () => host.garage.store;
  const signedIn = (): boolean => sample !== null || store().signedIn;
  const view = (): GarageView => (sample !== null ? garageView({ signedIn: true, equipped: 'dune', owned: sample.owned, shop: sample.shop, selected }) : store().view(selected));

  // ---- left: TU AUTO, PUNTOS DE SERVIDOR, GANA PUNTOS ----
  const yourName = h('h2.mn-gar-your-name');
  const yourFree = h('span.mn-gar-free', null, t('garage.free'));
  const yourDesc = h('p.mn-gar-desc');
  const yourCard = h('section.mn-gar-card.mn-gar-your', null, h('span.mn-gar-corner', null, icon('check'), t('garage.equippedTag')), h('span.mn-gar-label', null, t('garage.yourCar')), yourName, yourFree, yourDesc);
  const pointsBody = h('div.mn-gar-points-body');
  const pointsCardEl = h('section.mn-gar-card.mn-gar-points', null, h('span.mn-gar-label', null, t('points.title')), pointsBody);
  const earn = h(
    'a.mn-gar-earn',
    { href: guideUrl(), target: '_blank', rel: 'noopener', 'data-nav': true, 'data-key': 'garage-earn', onclick: (e: MouseEvent) => earnClick(e) },
    h('span.mn-gar-earn-bg'),
    h('span.mn-gar-label', null, t('garage.eachCar', { points: formatPoints(EACH_CAR) })),
    h('b.mn-gar-earn-title', null, t('garage.earn')),
    h('span.mn-gar-earn-sub', null, t('garage.earnSub'), icon('next')),
  );
  const left = h('div.mn-gar-left', null, yourCard, pointsCardEl, earn);

  // The showroom fits the car into this box (frame()): the screen's see-through middle.
  const stage = h('div.mn-gar-stage');

  // ---- right: the tabs, a phone's points line, the list, the detail ----
  const tabEls = new Map<Tab, HTMLButtonElement>();
  const tabButton = (id: Tab, label: string, kb: 'key-q' | 'key-e', pad: 'pad-lt' | 'pad-rt'): HTMLButtonElement => {
    const keys = [h('span.mn-keys-kb', null, glyph(kb)), h('span.mn-keys-pad', null, glyph(pad))];
    const name = h('span.mn-gar-tab-name', null, label);
    const b = h('button.mn-tab.mn-gar-tab', { type: 'button', role: 'tab', 'data-nav': true, 'data-key': 'garage-tab-' + id, onclick: () => pickTab(id) }, h('span.mn-gar-tab-bg'), ...(id === 'cars' ? [...keys, name] : [name, ...keys]));
    // Focus = selection (the arrows onto a tab, a remote's ◀ ▶).
    b.addEventListener('focus', () => pickTab(id));
    tabEls.set(id, b);
    return b;
  };
  const tabs = h('div.mn-tabs.mn-gar-tabs', { role: 'tablist', 'aria-label': t('nav.garage'), 'data-nav-row': true }, tabButton('cars', t('garage.tabCars'), 'key-q', 'pad-lt'), tabButton('stadiums', t('garage.tabStadiums'), 'key-e', 'pad-rt'));
  const compactPts = h('b.mn-gar-pts-num');
  const compact = h('button.mn-gar-compact', { type: 'button', 'data-nav': true, 'data-key': 'garage-compact', onclick: () => openGuide() }, icon('points', 'mn-gar-pts-icon'), compactPts, h('span.mn-gar-pts-unit', null, t('garage.pts')), h('span.mn-gar-compact-sep', null, '·'), h('span', null, t('garage.earnShort')), icon('next'));

  const rows = new Map<CarId, GarageRow>();
  for (const c of CARS) {
    const row = garageRow('garage-car-' + c.id, carSilhouette(c.id), carName(c.id), (e) => rowClick(c.id, e));
    row.el.addEventListener('focus', () => pickCar(c.id, false));
    rows.set(c.id, row);
  }
  const stadiumRows = new Map<ThemeId, GarageRow>();
  for (const { id } of stadiumOptions(host.theme)) {
    const row = garageRow('garage-stadium-' + id, icon('stadium', 'mn-gar-stadium-icon'), themeName(id), (e) => stadiumClick(id, e));
    row.el.addEventListener('focus', () => pickStadium(id));
    stadiumRows.set(id, row);
  }
  const list = h('div.mn-gar-list');

  const detName = h('b.mn-gar-det-name');
  const detPrice = h('span.mn-gar-det-price');
  const detReason = h('p.mn-gar-det-reason');
  const detAction = h('button.mn-btn.mn-gar-act', { type: 'button', 'data-nav': true, 'data-nav-line': true, 'data-key': 'garage-act', onclick: () => act() });
  const detail = h('div.mn-gar-detail', null, h('div.mn-gar-det-head', null, detName, detPrice), detReason, detAction);
  const right = h('section.mn-gar-right', null, compact, tabs, list, detail);

  const el = h('div.mn-garage', { 'data-tab': tab }, left, stage, right);

  /**
   * ◀ from the right column crosses the stage to the left column's control (SIGN IN, else GANA
   * PUNTOS), ▶ from there back to the row picked. The rows and the action are lines (nav.ts): ▶
   * from them bounces, never up to the ESTADIOS tab (its focus would switch the list), and without
   * a left column (a phone) ◀ goes to the rail, else bounces.
   */
  const updateSides = (): void => {
    const visible = (e: HTMLElement): boolean => e.getClientRects().length > 0;
    const leftOne = (): HTMLElement | null => [pointsBody.querySelector<HTMLElement>('[data-nav]'), earn].find((e): e is HTMLElement => e !== null && visible(e)) ?? null;
    const on = visible(left) && leftOne() !== null;
    const toLeft = on ? () => leftOne()?.focus({ preventScroll: true }) : null;
    const toRow = on ? () => (tab === 'cars' ? rows.get(view().selected.id) : stadiumRows.get(stadium))?.el.focus({ preventScroll: true }) : null;
    for (const r of [...rows.values(), ...stadiumRows.values()]) onNavSide(r.el, toLeft, null);
    onNavSide(detAction, toLeft, null);
    onNavSide(earn, null, toRow);
    const b = pointsBody.querySelector<HTMLElement>('[data-nav]');
    if (b !== null) onNavSide(b, null, toRow);
  };

  /** Rebuild `box` only when what it shows changed (`key`): a focused button inside it keeps the focus. */
  const draw = (box: HTMLElement, key: string, build: () => Child[]): void => {
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    setChildren(box, ...build());
  };

  // ---- picking ----
  const pickTab = (id: Tab): void => {
    if (tab === id) return;
    tab = id;
    render();
  };
  const pickCar = (id: CarId, now: boolean): void => {
    if (selected !== id) {
      selected = id;
      render();
    }
    schedulePreview(now);
  };
  const pickStadium = (id: ThemeId): void => {
    if (stadium === id) return;
    stadium = id;
    render();
  };
  /** A press with no pointer (Enter, OK, a controller's A) on the row picked: its action. */
  const toAction = (e: MouseEvent, was: boolean): void => {
    if (e.detail === 0 && was && !detAction.hidden) detAction.focus({ preventScroll: true });
  };
  const rowClick = (id: CarId, e: MouseEvent): void => {
    const was = view().selected.id === id;
    pickCar(id, true);
    toAction(e, was);
  };
  const stadiumClick = (id: ThemeId, e: MouseEvent): void => {
    const was = stadium === id;
    pickStadium(id);
    toAction(e, was);
  };

  /** The car picked in the showroom: at once, or once the focus rested PREVIEW_MS (arrowing down the list swaps no body per row). */
  const schedulePreview = (now: boolean): void => {
    window.clearTimeout(previewTimer);
    const run = (): void => {
      if (!shown || tab !== 'cars') return;
      const s = view().selected;
      setPreview(s.state === 'equipped' ? null : s.id);
    };
    if (now) run();
    else previewTimer = window.setTimeout(run, PREVIEW_MS);
  };
  const setPreview = (id: CarId | null): void => {
    if (id === previewed) return;
    previewed = id;
    host.garage.preview(id);
  };

  // ---- drawing ----
  const drawPoints = (v: GarageView): void => {
    const p = pointsCard(v, { signedIn: signedIn(), loading: store().loading, error: sample !== null ? null : store().error });
    compactPts.textContent = formatPoints(p.points);
    if (PREVIEW_ALL_CARS && p.kind === 'preview') {
      draw(pointsBody, 'preview:' + language(), () => [h('p.mn-gar-text', null, previewNotice(language()))]);
      return;
    }
    const balance = (): HTMLElement => h('div.mn-gar-balance', null, icon('points', 'mn-gar-balance-icon'), h('b.mn-gar-balance-num', null, formatPoints(p.points)), h('span.mn-gar-balance-unit', null, t('garage.pts')));
    const only = (): HTMLElement => h('p.mn-gar-text', null, t('points.only'));
    switch (p.kind) {
      case 'guest':
        draw(pointsBody, 'guest', () => [
          balance(),
          only(),
          h('div.mn-gar-signin', null, h('button.mn-btn.mn-gar-signin-btn', { type: 'button', 'data-nav': true, 'data-key': 'garage-signin', onclick: () => signIn() }, t('garage.signIn')), h('span.mn-gar-guest', null, t('garage.guest'))),
        ]);
        return;
      case 'account':
        draw(pointsBody, `a:${p.points}:${p.paused}`, () => [balance(), only(), p.paused ? h('p.mn-gar-warn', null, icon('warning'), t('garage.paused')) : null]);
        return;
      case 'error': {
        const error = store().error ?? '';
        draw(pointsBody, 'e:' + error, () => [h('p.mn-gar-warn', null, error), h('button.mn-btn.mn-btn-small', { type: 'button', 'data-nav': true, 'data-key': 'garage-retry', onclick: () => void store().refresh() }, t('garage.retry'))]);
        return;
      }
      default:
        draw(pointsBody, 'loading', () => [h('p.mn-gar-text', null, t('garage.loading'))]);
    }
  };

  const drawCars = (v: GarageView): void => {
    for (const c of v.cars) rows.get(c.id)?.set(lineText(rowLine(c)), c.state, c.selected);
    const equipped = v.cars.find((c) => c.state === 'equipped') ?? v.cars[0];
    for (const c of v.cars) rows.get(c.id)?.el.toggleAttribute('data-autofocus', c.id === equipped.id);
    yourName.textContent = carName(equipped.id);
    yourFree.hidden = equipped.price > 0;
    yourDesc.textContent = carDescription(equipped.id);
    const s = v.selected;
    const d = detailView(s, v);
    detName.textContent = carName(s.id);
    setChildren(detPrice, ...(s.price > 0 ? price(s.price) : [h('span.mn-gar-pts-unit', null, t('garage.freeTag'))]));
    writeReason(d.reason !== null ? lineText(d.reason) : '', d.tone);
    detAction.hidden = d.button === null;
    detAction.textContent = d.button === 'equip' ? t('garage.equip') : t('garage.redeem', { points: formatPoints(s.price) });
    detAction.classList.toggle('mn-btn-primary', d.lime);
    detAction.classList.toggle('mn-gar-act-off', !d.lime);
    detAction.setAttribute('aria-busy', busy ? 'true' : 'false');
  };

  const drawStadiums = (): void => {
    for (const { id, on } of stadiumOptions(host.theme)) {
      const row = stadiumRows.get(id);
      if (row === undefined) continue;
      row.set(on ? t('garage.stadiumInUse') : '', on ? 'inUse' : 'free', id === stadium);
      row.el.toggleAttribute('data-autofocus', on);
      if (on) row.el.setAttribute('aria-current', 'true');
      else row.el.removeAttribute('aria-current');
    }
    detName.textContent = themeName(stadium);
    setChildren(detPrice);
    writeReason(t('garage.stadiumNote'), 'plain');
    detAction.hidden = stadium === host.theme;
    detAction.textContent = t('garage.stadiumUse');
    detAction.classList.add('mn-btn-primary');
    detAction.classList.remove('mn-gar-act-off');
    detAction.setAttribute('aria-busy', 'false');
  };

  const writeReason = (text: string, tone: 'plain' | 'lock' | 'warn'): void => {
    detReason.hidden = text === '';
    detReason.dataset.tone = tone;
    setChildren(detReason, tone === 'lock' ? icon('lock') : tone === 'warn' ? icon('warning') : null, h('span', null, text));
  };

  function render(): void {
    const v = view();
    el.dataset.tab = tab;
    for (const [id, b] of tabEls) {
      b.classList.toggle('mn-tab-on', id === tab);
      b.setAttribute('aria-selected', id === tab ? 'true' : 'false');
    }
    const want = tab === 'cars' ? [...rows.values()] : [...stadiumRows.values()];
    // The other tab's rows: a focus in the list goes to the new list's pick (Q / E, LT / RT from a row).
    const listFocused = list.contains(document.activeElement);
    if (list.firstElementChild !== want[0].el) setChildren(list, ...want.map((r) => r.el));
    const actFocused = document.activeElement === detAction;
    drawPoints(v);
    earn.classList.toggle('mn-gar-earn-lime', earnIsLime(v));
    if (tab === 'cars') drawCars(v);
    else drawStadiums();
    const pickedRow = tab === 'cars' ? rows.get(v.selected.id) : stadiumRows.get(stadium);
    // An equip made the action go (the car is driven now): the focus back on its row.
    if ((listFocused && !list.contains(document.activeElement)) || (actFocused && detAction.hidden)) pickedRow?.el.focus({ preventScroll: true });
    updateSides();
    // The car driven again after an equip, a claim or a tab away from the cars.
    if (shown && previewed !== null && (tab !== 'cars' || v.selected.state === 'equipped')) setPreview(null);
  }

  // ---- actions ----
  const act = (): void => {
    if (tab === 'stadiums') {
      chooseStadium(host, stadium);
      render();
      return;
    }
    const v = view();
    const s = v.selected;
    if (busy) return;
    switch (detailView(s, v).press) {
      case 'equip':
        equip(s.id);
        return;
      case 'redeem':
        openRedeem(s);
        return;
      case 'signIn':
        signIn();
        return;
      case 'earn':
        openGuide();
        return;
      case 'profile':
        menu.open('profile');
        return;
      default:
        return;
    }
  };

  const signIn = (): void => {
    waitSignIn = true;
    menu.open('profile', false, undefined, true);
  };

  const equip = (id: CarId): void => {
    if (sample !== null) return;
    busy = true;
    render();
    void store()
      .equip(id)
      .then(
        (ok) => {
          if (ok) menu.toast(t('garage.equipped', { car: carName(id) }), 'ok');
        },
        (err: unknown) => menu.toast(errorText(err), 'error'),
      )
      .finally(() => {
        busy = false;
        if (shown) render();
      });
  };

  const held = (): boolean => host.acceptHeld?.() ?? false;

  /** The redeem sheet: the cost, the balance after it, CANCELAR focused and MANTÉN PARA CONFIRMAR. */
  const openRedeem = (c: GarageCarView): void => {
    const balance = view().wallet?.balance ?? 0;
    const { from, to } = redeemBalance(c.price, balance);
    const car = carName(c.id);
    closeSheet = menu.modal({
      title: t('garage.redeemTitle', { car }),
      body: h(
        'div.mn-gar-redeem',
        null,
        carSilhouette(c.id, 'mn-car-sil mn-gar-redeem-sil'),
        h('div.mn-gar-redeem-lines', null, h('span', null, t('garage.cost', { points: formatPoints(c.price) })), h('b.mn-gar-redeem-balance', null, t('garage.balance', { from: formatPoints(from), to: formatPoints(to) })), h('p.mn-gar-redeem-note', null, t('garage.noPay'))),
      ),
      actions: [
        { label: t('garage.cancel'), autofocus: true, onClick: () => true },
        {
          label: t('garage.hold'),
          primary: true,
          hold: { ms: REDEEM_HOLD_MS, held },
          onClick: async () => {
            if (sample !== null) return true;
            try {
              await store().claim(c.id);
            } catch (err) {
              openFailed(c.id, err);
              return;
            }
            openRedeemed(c.id);
          },
        },
      ],
    });
  };

  const openRedeemed = (id: CarId): void => {
    const car = carName(id);
    menu.modal({
      title: t('garage.redeemed', { car }),
      body: h('div.mn-gar-redeem', null, carSilhouette(id, 'mn-car-sil mn-gar-redeem-sil'), h('p.mn-gar-redeem-note', null, t('garage.same'))),
      actions: [
        { label: t('garage.equipNow'), primary: true, onClick: () => equip(id) },
        { label: t('garage.done'), onClick: () => true },
      ],
    });
  };

  const openFailed = (id: CarId, err: unknown): void => {
    menu.modal({
      title: t('garage.failTitle'),
      body: [h('p', null, errorText(err)), h('p.mn-gar-redeem-note', null, t('garage.failText'))],
      actions: [
        { label: t('garage.cancel'), onClick: () => true },
        {
          label: t('garage.retry'),
          primary: true,
          onClick: () => {
            const c = view().cars.find((x) => x.id === id);
            if (c !== undefined && c.state === 'claimable') openRedeem(c);
          },
        },
      ],
    });
  };

  /** How points are earned: the guide's QR (a phone opens it), and on a page with a pointer the guide itself. */
  const openGuide = (): void => {
    const url = guideUrl();
    closeSheet = menu.modal({
      title: t('garage.guideTitle'),
      body: h('div.mn-gar-guide', null, qrSvg(url, t('garage.guideTitle')), h('div.mn-gar-guide-text', null, h('p', null, t('garage.guideText')), h('p.mn-gar-redeem-note', null, t('garage.guideScan')))),
      actions: tv()
        ? [{ label: t('outcome.close'), primary: true, onClick: () => true }]
        : [
            {
              label: t('garage.guideOpen'),
              primary: true,
              onClick: () => {
                window.open(url, '_blank', 'noopener');
              },
            },
            { label: t('outcome.close'), onClick: () => true },
          ],
    });
  };

  /** GANA PUNTOS: the guide in a new tab, or (a TV, a remote, a controller: no pop-up from a pad press) its sheet. */
  const earnClick = (e: MouseEvent): void => {
    const input = html.dataset.input;
    if (!tv() && input !== 'pad' && input !== 'remote') return;
    e.preventDefault();
    openGuide();
  };

  // A sign-in on PERFIL (SIGN IN here): back to GARAJE (its points, its cars).
  host.accounts.subscribe(() => {
    if (!waitSignIn || !host.accounts.signedIn) return;
    waitSignIn = false;
    if (menu.top()?.id === 'profile') menu.open('garage');
  });

  /** The stage's box as viewport fractions (CSS order), the whole screen when it has no room. */
  const frame = (): ShowroomFrame => {
    const r = stage.getBoundingClientRect();
    const w = window.innerWidth;
    const hh = window.innerHeight;
    if (r.width < 24 || r.height < 24 || w <= 0 || hh <= 0) return FULL_FRAME;
    return { x0: r.left / w, y0: r.top / hh, x1: r.right / w, y1: r.bottom / hh };
  };
  const place = (): void => {
    if (!shown) return;
    host.garage.showroom(frame());
    updateSides(); // a phone turned: the left column comes or goes
  };
  // A layout change (a resize, a phone turned, the list growing) fits the car again.
  const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null;

  // The samples exist in development and in a VITE_UI_FIT=1 build only (read here: node tests import this module).
  if (import.meta.env.DEV || import.meta.env.VITE_UI_FIT === '1') {
    (window as unknown as { __garage: (kind: SampleKind | null) => void }).__garage = (kind) => {
      closeSheet?.();
      sample = kind === null ? null : sampleShop(kind);
      tab = kind === 'stadiums' ? 'stadiums' : 'cars';
      selected = kind === 'owned' ? 'pampero' : kind === 'points' || kind === 'redeem' ? 'carpincho' : null;
      if (shown) render();
      if (kind === 'redeem') openRedeem(view().selected);
      if (kind === 'guide') openGuide();
    };
  }

  return {
    id: 'garage',
    title: t('nav.garage'),
    el,
    tabsVerb: 'garage.tabsVerb',
    setTab: (id) => {
      if (id === 'cars' || id === 'stadiums') tab = id;
    },
    show: () => {
      shown = true;
      selected = null;
      stadium = host.theme;
      waitSignIn = false;
      previewed = null;
      unsubscribe?.();
      unsubscribe = store().subscribe(() => {
        if (shown) render();
      });
      render();
      place();
      resized?.observe(stage);
      window.addEventListener('resize', place);
      // The account's cars, what it can redeem and its points (a guest reads nothing).
      void store().refresh();
    },
    hide: () => {
      shown = false;
      tab = 'cars';
      window.clearTimeout(previewTimer);
      unsubscribe?.();
      unsubscribe = null;
      resized?.disconnect();
      window.removeEventListener('resize', place);
      // The camera back to the menus, the player's own body back on its car.
      previewed = null;
      host.garage.showroom(null);
    },
  };
}

/** Sample shop answers (window.__garage): 0 points, enough for one car, a car owned, claims paused. */
function sampleShop(kind: SampleKind): { kind: SampleKind; shop: ShopAnswer; owned: string[] } {
  const balance = kind === 'points' || kind === 'redeem' ? 2100 : kind === 'owned' ? 600 : kind === 'paused' ? 1800 : 0;
  const owned = kind === 'owned' ? ['pampero'] : [];
  const items = CARS.filter((c) => c.price > 0).map((c) => {
    const own = owned.includes(c.id);
    const claimable = !own && kind !== 'paused' && balance >= c.price;
    const blocked = own || claimable ? undefined : kind === 'paused' ? ('frozen' as const) : ('insufficient' as const);
    return { id: c.id, kind: 'car' as const, name: c.id, description: '', cost: c.price, status: 'available' as const, owned: own, claimable, ...(blocked !== undefined ? { blocked } : {}) };
  });
  return { kind, owned, shop: { items, wallet: { earned: balance + (kind === 'owned' ? 1500 : 0), spent: kind === 'owned' ? 1500 : 0, balance, frozen: kind === 'paused' ? 'review' : null } } };
}
