/**
 * `mn-codecells` (plan §1.3): a lobby code's six cells of 56 px over one real text field, so a
 * keyboard types, a phone's keyboard and a paste fill it, and an IME composes, as in any field; only
 * the server's alphabet gets in (screens/lobbyModel.ts cleanCode: no I, O, 0 or 1). The field is the
 * focus target (`data-nav`, Menu's field modes: OK starts editing, ◀ ▶ move the caret, Back stops).
 * While editing, ▲ ▼ (a remote, a pad: nav.ts's navUp / navDown claims) step the character of the
 * cell under the caret through the alphabet, so a remote alone can enter a code. Typing or pasting
 * the sixth character submits (`onFull`); OK on a full code does too. Built on call.
 */
import { h } from '../dom';
import { CODE_LENGTH, cleanCode, cycleCell } from '../screens/lobbyModel';
import { isEditing, onEditStep, setEditing } from '../nav';

export interface CodeCells {
  readonly el: HTMLElement;
  readonly input: HTMLInputElement;
  /** The code so far (capitals, the alphabet only). */
  value(): string;
  set(code: string): void;
}

export function codeCells(label: string, onFull: (code: string) => void): CodeCells {
  const cells = Array.from({ length: CODE_LENGTH }, () => h('span.mn-cell', { 'aria-hidden': 'true' }));
  const input = h('input.mn-codecells-input', {
    type: 'text',
    inputMode: 'text',
    autocomplete: 'off',
    autocapitalize: 'characters',
    maxLength: 12, // a paste with a space or a dash still fits before it is cleaned
    'aria-label': label,
    'data-nav': true,
    'data-key': 'codecells',
    'data-autofocus': true,
  });
  input.spellcheck = false; // (h() skips a false prop)
  const el = h('div.mn-codecells', null, ...cells, input);

  /** The cell the caret is on (the next one to fill; the last one once full). */
  const at = (): number => Math.min(input.selectionStart ?? input.value.length, CODE_LENGTH - 1);
  const render = (): void => {
    const v = input.value;
    const focused = document.activeElement === input;
    const cur = at();
    cells.forEach((c, i) => {
      const ch = v[i] ?? '';
      if (c.textContent !== ch) c.textContent = ch;
      c.classList.toggle('mn-cell-on', focused && i === cur);
    });
  };
  let last = '';
  const sync = (typed: boolean): void => {
    const pos = input.selectionStart ?? input.value.length;
    const clean = cleanCode(input.value);
    if (clean !== input.value) {
      input.value = clean;
      const p = Math.min(pos, clean.length);
      input.setSelectionRange(p, p);
    }
    render();
    // Typed or pasted to the sixth: that is the code (the remote's ▲ ▼ steps never submit by themselves).
    if (typed && clean.length === CODE_LENGTH && last.length < CODE_LENGTH) onFull(clean);
    last = clean;
  };
  input.addEventListener('input', () => sync(true));
  for (const ev of ['keyup', 'click', 'select']) input.addEventListener(ev, render);
  // The caret moved by the pad (nav.ts caretStep) fires no key: the document's selectionchange, while focused.
  input.addEventListener('focus', () => {
    document.addEventListener('selectionchange', render);
    render();
  });
  input.addEventListener('blur', () => {
    document.removeEventListener('selectionchange', render);
    render();
  });
  input.addEventListener('keydown', (e) => {
    // OK on a full code (Menu.onFieldKey ends the editing on Enter: this runs after it). Its default
    // is taken: the sheet closes and the focus goes back to its opener, which the same Enter's
    // keypress would press again.
    if (e.key === 'Enter' && input.value.length === CODE_LENGTH && !e.defaultPrevented) {
      e.preventDefault();
      onFull(input.value);
    }
  });
  const step = (d: -1 | 1): boolean => {
    if (!isEditing(input)) return false;
    const i = at();
    input.value = cycleCell(input.value, i, d);
    input.setSelectionRange(i, i);
    last = input.value;
    render();
    return true;
  };
  onEditStep(input, () => step(1), () => step(-1));
  return {
    el,
    input,
    value: () => input.value,
    set: (code) => {
      input.value = cleanCode(code);
      last = input.value;
      if (isEditing(input)) setEditing(input, false);
      render();
    },
  };
}
