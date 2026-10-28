/**
 * `mn-seg` (plan §1.3): two to four options side by side, the picked one on --surface-3 with a lime
 * dash. A row (nav.ts data-nav-row): ◀ ▶ walk the options, A / Enter / a click picks. It replaces
 * the old ‹ › cyclers of four options or fewer (MODOS' VS AI: mode and difficulty).
 */
import { h } from '../dom';

export interface SegOption<T> {
  value: T;
  label: string;
}

export interface Seg<T> {
  readonly el: HTMLElement;
  /** Re-read the value (written only when the pick changed). */
  refresh(): void;
  readonly buttons: readonly HTMLButtonElement[];
  readonly options: readonly SegOption<T>[];
}

/** `key` names the row's buttons for the focus memory (`<key>-<i>`); `label` is its name for a screen reader. */
export function seg<T>(key: string, label: string, options: readonly SegOption<T>[], get: () => T, set: (v: T) => void): Seg<T> {
  const buttons = options.map((o, i) =>
    h(
      'button.mn-seg-opt',
      {
        type: 'button',
        role: 'radio',
        'data-nav': true,
        'data-key': `${key}-${i}`,
        'aria-checked': 'false',
        onclick: () => {
          set(o.value);
          refresh();
        },
      },
      o.label,
    ),
  );
  const el = h('div.mn-seg', { role: 'radiogroup', 'aria-label': label, 'data-nav-row': true }, ...buttons);
  const refresh = (): void => {
    const v = get();
    options.forEach((o, i) => {
      const on = String(o.value === v);
      if (buttons[i].getAttribute('aria-checked') !== on) buttons[i].setAttribute('aria-checked', on);
    });
  };
  refresh();
  return { el, refresh, buttons, options };
}
