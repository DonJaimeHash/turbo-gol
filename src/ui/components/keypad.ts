/**
 * `mn-keypad` (plan §1.3, dir-hub §6.15): the on-screen keys of a device with no fine pointer (a TV
 * remote, a phone's controller), so a remote alone can write a name, a password or a lobby code.
 * The Menu opens it with OK / A on a text field in navigation mode (Menu.openKeypad; a fine pointer
 * or a physical keyboard types as before) and mounts it over everything, a sheet too: a grid of
 * keys the arrows walk (FocusNav, a zone of its own: ▲ ▼ by place, ◀ ▶ along the row, round, as a
 * held arrow too), OK / A types the key focused, ⌫ deletes,
 * ESPACIO, ABC / abc (the case), LISTO writes the text and returns to the field; Back writes it too
 * ("what was typed stays"). A key typed on a keyboard meanwhile types too (Backspace deletes, on an
 * empty text it is Back).
 * - 'text': A–Z, 0–9 and . - _ @ (usernames: account.ts usernameIssue; passwords need the case).
 * - 'code': the lobby alphabet only (lobbyModel.ts CODE_ALPHABET), capitals, six at most (the code
 *   cells: components/codecells.ts registers it with onKeypad).
 * A password field shows dots, never its text (nor in a label or a hint). The field's maxLength holds.
 * The pure part (keypadRows, keypadType, keypadShown) is unit-tested (tests/tv-signin.test.mjs);
 * keypadBox builds the DOM on call.
 */
import { h } from '../dom';
import { onNavRepeat, onNavSide } from '../nav';
import { icon } from './icons';
import { CODE_ALPHABET, CODE_LENGTH } from '../screens/lobbyModel';
import { t } from '../../i18n';

export type KeypadKind = 'text' | 'code';

/** A key of the bottom row (the characters are their own keys). */
export type KeypadAction = 'case' | 'delete' | 'space' | 'done';

const TEXT_ROWS = ['ABCDEFGHIJ', 'KLMNOPQRST', 'UVWXYZ.-_@', '1234567890'];
const CODE_ROWS = [0, 8, 16, 24].map((i) => CODE_ALPHABET.slice(i, i + 8));

/** The character rows of `kind` (capitals; `lower`: the letters in lower case). Pure. */
export function keypadRows(kind: KeypadKind, lower = false): string[] {
  const rows = kind === 'code' ? CODE_ROWS : TEXT_ROWS;
  return lower && kind === 'text' ? rows.map((r) => r.toLowerCase()) : [...rows];
}

/** The bottom row of `kind`: no case and no space for a code. Pure. */
export function keypadActions(kind: KeypadKind): KeypadAction[] {
  return kind === 'code' ? ['delete', 'done'] : ['case', 'delete', 'space', 'done'];
}

/**
 * `value` after typing `key` (a character, or 'delete' / 'space'): `max` characters at most, and for
 * a code only its alphabet (in capitals). Pure.
 */
export function keypadType(value: string, key: string, kind: KeypadKind, max: number): string {
  if (key === 'delete') return [...value].slice(0, -1).join('');
  const ch = key === 'space' ? ' ' : kind === 'code' ? key.toUpperCase() : key;
  if ([...ch].length !== 1 || [...value].length >= (kind === 'code' ? Math.min(max, CODE_LENGTH) : max)) return value;
  if (kind === 'code' ? !CODE_ALPHABET.includes(ch) : ch === ' ' && value.length === 0) return value; // no leading space
  return value + ch;
}

/** What the keypad shows of `value`: dots for a password. Pure. */
export function keypadShown(value: string, masked: boolean): string {
  return masked ? '•'.repeat([...value].length) : value;
}

/**
 * The default write on LISTO / Back: the value, then the events a typed edit ends with (input, then
 * change as its blur would send: EXPERIMENTAL's preset name commits on change). Nothing when unchanged.
 */
export function keypadWrite(field: Pick<HTMLInputElement, 'value' | 'dispatchEvent'>, value: string): void {
  if (value === field.value) return;
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
}

/** A field's own keypad: its keys and where the text goes (default: keypadWrite). */
export interface KeypadSpec {
  kind?: KeypadKind;
  /** The text on LISTO (`done`) or Back. */
  write?(value: string, done: boolean): void;
}

export function onKeypad(el: HTMLInputElement, spec: KeypadSpec): void {
  (el as HTMLInputElement & { keypad?: KeypadSpec }).keypad = spec;
}

export function keypadSpec(el: HTMLInputElement): KeypadSpec {
  return (el as HTMLInputElement & { keypad?: KeypadSpec }).keypad ?? {};
}

export interface KeypadView {
  readonly el: HTMLElement;
  value(): string;
}

export interface KeypadOptions {
  /** The field's name (the keypad's heading). */
  label: string;
  value: string;
  kind: KeypadKind;
  masked: boolean;
  max: number;
  /** LISTO. */
  done: (value: string) => void;
  /** Focus a key as the arrows do (Menu: FocusNav.focus). */
  focus: (el: HTMLElement) => void;
}

const ACTION_LABEL: Readonly<Record<KeypadAction, 'keypad.case' | 'keypad.delete' | 'keypad.space' | 'keypad.done'>> = {
  case: 'keypad.case',
  delete: 'keypad.delete',
  space: 'keypad.space',
  done: 'keypad.done',
};

export function keypadBox(o: KeypadOptions): KeypadView {
  let value = o.value;
  let lower = false;
  const text = h('span.mn-keypad-text');
  const shown = h('div.mn-keypad-shown', null, text, h('span.mn-keypad-caret', { 'aria-hidden': 'true' }));
  const render = (): void => {
    text.textContent = keypadShown(value, o.masked);
    shown.classList.toggle('mn-keypad-empty', value.length === 0);
    shown.classList.toggle('mn-keypad-long', [...value].length > 20); // the end shows (what was typed last)
  };
  const press = (key: string): void => {
    value = keypadType(value, key, o.kind, o.max);
    render();
  };
  const chars: HTMLButtonElement[] = [];
  const rows = keypadRows(o.kind).map((row) =>
    h(
      'div.mn-keypad-row',
      null,
      ...[...row].map((ch) => {
        const b = h('button.mn-kp-key', { type: 'button', 'data-nav': true, 'data-key': 'key-' + ch }, ch);
        b.addEventListener('click', () => press(b.textContent ?? ''));
        chars.push(b);
        return b;
      }),
    ),
  );
  const caseKey = (): void => {
    lower = !lower;
    const letters = keypadRows(o.kind, lower).join('');
    chars.forEach((b, i) => (b.textContent = letters[i]));
  };
  const actions = keypadActions(o.kind).map((a) => {
    const label = a === 'delete' ? icon('back', 'mn-kp-icon') : a === 'case' ? 'abc' : t(ACTION_LABEL[a]);
    const b = h(`button.mn-kp-key.mn-kp-${a}` as 'button', { type: 'button', 'data-nav': true, 'data-key': 'key-' + a, 'aria-label': t(ACTION_LABEL[a]) }, label);
    b.addEventListener('click', () => {
      if (a === 'done') o.done(value);
      else if (a === 'case') {
        caseKey();
        b.textContent = lower ? 'ABC' : 'abc';
      } else press(a);
    });
    return b;
  });
  // ◀ ▶ along a row, round (a wide key beside narrow ones would take the next row's key otherwise).
  const rowKeys = [...rows.map((r) => [...r.querySelectorAll<HTMLElement>('.mn-kp-key')]), actions];
  for (const keys of rowKeys) {
    keys.forEach((b, i) => {
      onNavSide(b, () => o.focus(keys[(i - 1 + keys.length) % keys.length]), () => o.focus(keys[(i + 1) % keys.length]));
      onNavRepeat(b);
    });
  }
  const el = h(
    'div.mn-keypad',
    // data-masked: a password's keypad (`#keys`, keysOverlay.ts, then shows no key either).
    { role: 'dialog', 'aria-modal': 'true', 'aria-label': o.label, 'data-kind': o.kind, 'data-masked': o.masked ? 'true' : undefined },
    h('div.mn-keypad-head', null, h('span.mn-keypad-label', null, o.label), shown),
    ...rows,
    h('div.mn-keypad-row.mn-keypad-actions', null, ...actions),
  );
  // The OK that opened it, held: its repeats press no key (only a press made here does).
  let fresh = false;
  // A keyboard meanwhile (a TV's own, a phone's Bluetooth one): its characters type, Backspace deletes.
  el.addEventListener('keydown', (e) => {
    if (!e.repeat) fresh = true;
    else if (!fresh && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || typeof e.key !== 'string') return;
    if (e.key === 'Backspace') {
      if (value.length === 0) return; // Back (Menu.onKey)
      press('delete');
    } else if (e.key === ' ' && o.kind === 'text') press('space');
    else if (e.key.length === 1 && e.key !== ' ') press(e.key);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  render();
  return { el, value: () => value };
}
