/**
 * The player plate (plan §1.3 `mn-plate`; styles/tiles.css): who you are (avatar or rank badge,
 * name, rank line) opening PERFIL, then your car (GARAJE · Dune) opening GARAJE, on Inicio's top
 * row (PC, short, TV, upright; a phone held sideways has both in its rail). A TV shows the first
 * half only, its line ending in the car. `set` rewrites the two buttons' content and keeps the
 * buttons, so a refresh (a sign-in, a rank) leaves the focus where it was. Built on call.
 */
import { h, setChildren } from '../dom';
import { icon } from './icons';
import { t } from '../../i18n';

export interface PlateView {
  /** The "?" of a guest (`span.mn-plate-avatar`) or an account's rank badge (badges.ts). */
  avatar: HTMLElement;
  name: string;
  line: string;
  carName: string;
  /** The two buttons' names for a screen reader (home.plateProfile, home.plateGarage). */
  profileLabel: string;
  garageLabel: string;
}

export function plate(handlers: { profile: () => void; garage: () => void }): { el: HTMLElement; set(v: PlateView): void } {
  const id = h('button.mn-plate-id', { type: 'button', 'data-nav': true, 'data-key': 'plate-profile', onclick: () => handlers.profile() });
  const car = h('button.mn-plate-car', { type: 'button', 'data-nav': true, 'data-key': 'plate-garage', onclick: () => handlers.garage() });
  const set = (v: PlateView): void => {
    setChildren(id, v.avatar, h('span.mn-plate-text', null, h('b.mn-plate-name', null, v.name), h('span.mn-plate-line', null, v.line)));
    setChildren(car, icon('garage'), h('span.mn-plate-text', null, h('span.mn-plate-label', null, t('nav.garage')), h('b.mn-plate-carname', null, v.carName)), icon('next'));
    id.setAttribute('aria-label', v.profileLabel);
    car.setAttribute('aria-label', v.garageLabel);
  };
  return { el: h('div.mn-plate', null, id, car), set };
}
