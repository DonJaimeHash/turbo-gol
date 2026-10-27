/**
 * `mn-picker` (plan §1.3): a 56 px row, an icon, its name, the value and ›; a press opens its sheet
 * (the region sheet, Advanced's connection, a stadium), which comes back with the focus on the row.
 */
import { h } from '../dom';
import { icon } from './icons';
import type { IconName } from './icons';

export interface Picker {
  readonly el: HTMLButtonElement;
  /** Show `value` (written only when it changed). */
  set(value: string): void;
}

export function picker(key: string, glyph: IconName, label: string, open: () => void): Picker {
  const value = h('span.mn-picker-value');
  const el = h('button.mn-picker', { type: 'button', 'data-nav': true, 'data-key': key, onclick: open }, icon(glyph), h('span.mn-picker-label', null, label), value, icon('next'));
  return {
    el,
    set: (v) => {
      if (value.textContent !== v) value.textContent = v;
      el.setAttribute('aria-label', `${label}: ${v}`);
    },
  };
}
