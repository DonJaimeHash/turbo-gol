/**
 * Shared menu controls: big navigation tiles, a value cycler (‹ value ›, left / right on the
 * controller), segmented buttons, text fields with a label and an error line, a region picker.
 */
import { h, navButton } from '../dom';
import type { Child } from '../dom';
import { onNavSide } from '../nav';
import { REGIONS } from '../../net/account';
import type { RegionId } from '../../net/account';
import type { Menu } from '../Menu';

/** A big menu tile: icon glyph, title, subtitle, optional corner tag. */
export function tile(cls: string, glyph: string, title: string, sub: string, onClick: () => void, tag?: Child): HTMLButtonElement {
  return navButton(`mn-tile ${cls}`, [h('span.mn-tile-glyph', { 'aria-hidden': 'true' }, glyph), h('span.mn-tile-title', null, title), h('span.mn-tile-sub', null, sub), tag ? h('span.mn-tile-tag', null, tag) : null], onClick);
}

export interface CycleOption<T> {
  value: T;
  label: string;
}

/** "Label   ‹ value ›": click / Enter / → next, ← previous. `refresh()` re-reads the value. */
export function cycler<T>(label: string, options: readonly CycleOption<T>[], get: () => T, set: (v: T) => void): { el: HTMLElement; refresh: () => void } {
  const value = h('span.mn-cycle-value');
  const btn = h('button.mn-cycle', { type: 'button', 'data-nav': true }, h('span.mn-cycle-arrow', null, '‹'), value, h('span.mn-cycle-arrow', null, '›'));
  const idx = (): number => Math.max(0, options.findIndex((o) => o.value === get()));
  const refresh = (): void => {
    value.textContent = options[idx()]?.label ?? '';
  };
  const step = (d: number): void => {
    const i = (idx() + d + options.length) % options.length;
    set(options[i].value);
    refresh();
  };
  btn.addEventListener('click', (e) => {
    // A click on the left arrow goes back.
    const t = e.target as HTMLElement;
    step(t.classList.contains('mn-cycle-arrow') && t === btn.firstElementChild ? -1 : 1);
  });
  onNavSide(btn, () => step(-1), () => step(1));
  refresh();
  return { el: h('div.mn-row', null, h('span.mn-row-label', null, label), btn), refresh };
}

/** A labelled text field with an error line under it. */
export function field(label: string, opts: { type?: string; placeholder?: string; autocomplete?: string; maxLength?: number; value?: string } = {}): { el: HTMLElement; input: HTMLInputElement; error: (msg: string | null) => void } {
  const input = h('input.mn-input', {
    type: opts.type ?? 'text',
    placeholder: opts.placeholder ?? '',
    autocomplete: opts.autocomplete ?? 'off',
    maxLength: opts.maxLength ?? 64,
    value: opts.value ?? '',
    spellcheck: false,
    'data-nav': true,
  });
  const err = h('div.mn-field-error', { hidden: true });
  const el = h('label.mn-field', null, h('span.mn-field-label', null, label), input, err);
  return {
    el,
    input,
    error: (msg) => {
      err.hidden = msg === null;
      err.textContent = msg ?? '';
      el.classList.toggle('mn-field-bad', msg !== null);
    },
  };
}

/** The region cycler (Auto + every region); changing it re-polls the population. */
export function regionCycler(menu: Menu): { el: HTMLElement; refresh: () => void } {
  // The automatic region's name arrives with the server config, maybe after this screen was built.
  const autoLabel = (): string => {
    const n = REGIONS.find((r) => r.id === menu.cfg?.autoRegion)?.name;
    return n ? `Automática (${n})` : 'Automática';
  };
  const options: CycleOption<RegionId | null>[] = [{ value: null, label: autoLabel() }, ...REGIONS.map((r) => ({ value: r.id as RegionId | null, label: r.name }))];
  const c = cycler(
    'Región',
    options,
    () => menu.prefs.region,
    (v) => {
      menu.prefs.region = v;
      menu.savePrefs();
      menu.populationNow();
      menu.refreshChrome();
    },
  );
  return {
    el: c.el,
    refresh: () => {
      options[0].label = autoLabel();
      c.refresh();
    },
  };
}

/** A section with a heading. */
export function section(title: string, ...children: Child[]): HTMLElement {
  return h('section.mn-section', null, h('h2.mn-section-title', null, title), ...children);
}

export function screenHead(title: string, sub?: string): HTMLElement {
  return h('div.mn-head', null, h('h1.mn-title', null, title), sub ? h('div.mn-subtitle', null, sub) : null);
}

export function primary(label: string, onClick: () => void, extra?: Record<string, unknown>): HTMLButtonElement {
  return navButton('mn-btn mn-btn-primary mn-btn-big', label, onClick, extra);
}

export function secondary(label: string, onClick: () => void, extra?: Record<string, unknown>): HTMLButtonElement {
  return navButton('mn-btn', label, onClick, extra);
}
