/**
 * A row of GARAJE's list (plan §1.4.2, styles/screens/garage.css): the art in a dark slanted well
 * (a car's outline, components/carSilhouettes.ts, or a stadium's icon), the name in Display with a
 * ✓ for the one in use, and its state line ("Equipado · Gratis", "Bloqueado · 1.500 pts"); the row
 * picked has the lime bar on its left, a locked car the lock on its well. `data-state` carries the
 * state for the stylesheet (a locked car's outline in --edge-hi, one to come dashed). `set` writes
 * only what changed, so a focused row keeps its focus. Built on call.
 */
import { h } from '../dom';
import { icon } from './icons';

export type RowState = 'equipped' | 'owned' | 'claimable' | 'locked' | 'soon' | 'inUse' | 'free';

export interface GarageRow {
  readonly el: HTMLButtonElement;
  /** The state line, the state, whether it is the row picked. */
  set(line: string, state: RowState, picked: boolean): void;
}

export function garageRow(key: string, art: Element, name: string, onClick: (e: MouseEvent) => void): GarageRow {
  const lock = icon('lock', 'mn-car-lock');
  const check = icon('check', 'mn-car-check');
  const line = h('span.mn-car-state');
  const el = h(
    'button.mn-car-row',
    { type: 'button', 'data-nav': true, 'data-key': key, 'aria-pressed': 'false', onclick: (e: MouseEvent) => onClick(e) },
    h('span.mn-car-well', null, art, lock),
    h('span.mn-car-text', null, h('b.mn-car-name', null, h('span', null, name), check), line),
  );
  let shown = '';
  return {
    el,
    set: (text, state, picked) => {
      const key = `${text}|${state}|${picked}`;
      if (key === shown) return;
      shown = key;
      line.textContent = text;
      el.dataset.state = state;
      el.classList.toggle('mn-car-on', picked);
      el.setAttribute('aria-pressed', picked ? 'true' : 'false');
      el.setAttribute('aria-label', `${name}. ${text}`);
    },
  };
}
