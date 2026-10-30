/**
 * Shared menu controls: a value cycler (‹ value ›, left / right on the controller), text fields
 * with a label and an error line, a region picker, sections, heads and buttons.
 */
import { h, navButton } from '../dom';
import type { Child } from '../dom';
import { onNavSide } from '../nav';
import { REGIONS } from '../../net/account';
import type { RegionId } from '../../net/account';
import type { Menu } from '../Menu';
import { regionName } from '../names';
import { onKeypad } from '../components/keypad';
import type { KeypadKind } from '../components/keypad';
import { CODE_LENGTH, cleanCode } from '../../net/emailAuth';
import { t } from '../../i18n';

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

/** field()'s options (the sign-in PR 8 ones: hint, inputmode, readOnly, keypad, reveal). */
export interface FieldOptions {
  type?: string;
  placeholder?: string;
  autocomplete?: string;
  maxLength?: number;
  value?: string;
  enterkeyhint?: 'next' | 'go' | 'done';
  /** A line under the field that says what it is for (aria-describedby). */
  hint?: string;
  /** The phone keyboard to show ('email': '@' on it; 'numeric': digits). */
  inputmode?: 'email' | 'numeric' | 'text';
  readOnly?: boolean;
  /** mn-keypad's keys for it where there is no fine pointer (components/keypad.ts): 'email' has + and @, 'digits' 0-9. */
  keypad?: KeypadKind;
  /** A password's MOSTRAR / SHOW beside it (aria-pressed): the field shows its text while pressed. */
  reveal?: boolean;
}

/** A labelled field: its input, its error line (null clears it), and `note` for a line that is no error (a code accepted). */
export interface Field {
  el: HTMLElement;
  input: HTMLInputElement;
  error: (msg: string | null) => void;
  note: (msg: string | null) => void;
}

let fieldIds = 0;

/**
 * A labelled text field with an error line under it, a polite live region that names the field
 * (aria-describedby: its hint, then its error; aria-invalid while it shows one). `enterkeyhint`:
 * what a phone keyboard's Enter says ('next' on a form's fields but the last, 'go' / 'done' on that
 * one: profile.ts onEnter).
 */
export function field(label: string, opts: FieldOptions = {}): Field {
  const id = `mn-field-${++fieldIds}`;
  const input = h('input.mn-input', {
    type: opts.type ?? 'text',
    placeholder: opts.placeholder ?? '',
    autocomplete: opts.autocomplete ?? 'off',
    maxLength: opts.maxLength ?? 64,
    value: opts.value ?? '',
    spellcheck: false,
    enterKeyHint: opts.enterkeyhint,
    inputMode: opts.inputmode,
    readOnly: opts.readOnly === true,
    'data-nav': opts.readOnly === true ? undefined : true,
  });
  if (opts.keypad !== undefined) onKeypad(input, { kind: opts.keypad });
  const hint = opts.hint !== undefined ? h('div.mn-field-hint', { id: id + '-hint' }, opts.hint) : null;
  const err = h('div.mn-field-error', { id: id + '-err', hidden: true, 'aria-live': 'polite' });
  const describe = (): void => {
    const ids = [hint !== null ? hint.id : null, err.hidden ? null : err.id].filter((x): x is string => x !== null);
    if (ids.length > 0) input.setAttribute('aria-describedby', ids.join(' '));
    else input.removeAttribute('aria-describedby');
  };
  describe();
  const show = opts.reveal === true ? revealButton(input) : null;
  const box = show !== null ? h('span.mn-field-row', null, input, show) : input;
  const el = h('label.mn-field', null, h('span.mn-field-label', null, label), box, hint, err);
  const line = (msg: string | null, bad: boolean): void => {
    err.hidden = msg === null;
    err.textContent = msg ?? '';
    err.classList.toggle('mn-field-ok', msg !== null && !bad);
    el.classList.toggle('mn-field-bad', msg !== null && bad);
    if (msg !== null && bad) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
    describe();
  };
  return { el, input, error: (msg) => line(msg, true), note: (msg) => line(msg, false) };
}

/** MOSTRAR / SHOW: the password field `input` shows its text while pressed (aria-pressed), and its dots again on a second press. */
export function revealButton(input: HTMLInputElement): HTMLButtonElement {
  const b = h('button.mn-btn.mn-field-show', { type: 'button', 'data-nav': true, 'aria-pressed': 'false' }, t('auth.show'));
  b.addEventListener('click', (e) => {
    e.preventDefault(); // inside a <label>: no click on the field
    const on = input.type === 'password';
    input.type = on ? 'text' : 'password';
    b.setAttribute('aria-pressed', String(on));
  });
  return b;
}

/**
 * The 6-digit code of a mail (the sign-in design's §3.0): one field, `inputmode=numeric`,
 * `autocomplete=one-time-code` (a phone offers the code from its mail), the label read out as
 * "6-digit code"; a paste's spaces and dashes are dropped (emailAuth.ts cleanCode) and the sixth
 * digit calls `full`. mn-keypad's digits where there is no fine pointer.
 */
export function codeField(full: (code: string) => void): Field {
  const f = field(t('auth.codeLabel'), { autocomplete: 'one-time-code', inputmode: 'numeric', maxLength: 16, enterkeyhint: 'go', keypad: 'digits' });
  f.input.classList.add('mn-code-input');
  f.input.setAttribute('aria-label', t('auth.codeLabel'));
  f.input.setAttribute('pattern', '[0-9]*');
  let last = '';
  f.input.addEventListener('input', () => {
    const code = cleanCode(f.input.value);
    if (code !== f.input.value) f.input.value = code;
    if (code.length === CODE_LENGTH && code !== last) full(code);
    last = code;
  });
  return f;
}

/** The region cycler (Auto + every region); changing it re-polls the population. */
export function regionCycler(menu: Menu): { el: HTMLElement; refresh: () => void } {
  // The automatic region's name arrives with the server config, maybe after this screen was built.
  const autoLabel = (): string => {
    const r = REGIONS.find((x) => x.id === menu.cfg?.autoRegion);
    return r ? t('common.regionAutoNamed', { region: regionName(r.id) }) : t('common.regionAuto');
  };
  const options: CycleOption<RegionId | null>[] = [{ value: null, label: autoLabel() }, ...REGIONS.map((r) => ({ value: r.id as RegionId | null, label: regionName(r.id) }))];
  const c = cycler(
    t('common.region'),
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
