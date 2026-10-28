/**
 * The PageKit of Ajustes › EXPERIMENTAL (src/render/experimentalPage.ts, unchanged: it keeps its own
 * hud-exp-* / hud-rule-* classes and its children's order, tests/hud-menu.test.mjs). The page's
 * focus stops (PageItem) become FocusNav targets on the DOM: the row itself (`data-nav`), its ◀ ▶
 * (onNavSide; a stepper's follow a held arrow), A / Enter / OK its `accept` (a click on the row
 * itself, as FocusNav.accept sends), Delete / pad X its `clear` (SettingsView.command). Its buttons
 * (− +, New, Duplicate...) are the pointer's; the group's picked one keeps the page's .hud-focus.
 * The switch is the shell's NO │ SÍ.
 */
import { h } from '../../dom';
import { onNavRepeat, onNavSide } from '../../nav';
import type { PageItem, PageKit } from '../../../render/experimentalPage';
import { setRow, toggleSwitch } from '../../components/rows';

/** The page's item for a focused row (Delete / pad X: its `clear`). */
const ITEMS = new WeakMap<Element, PageItem>();

export function pageItemOf(el: Element | null): PageItem | null {
  return el === null ? null : (ITEMS.get(el) ?? null);
}

/** `relayout`: a row came or went (the focus it had goes back to the screen). */
export function experimentalKit(relayout: () => void): PageKit {
  return {
    line: (className, text) => h('div', { class: className }, text ?? null),
    button: (className, text, onClick) => h('button', { type: 'button', class: className, tabIndex: -1, onclick: onClick }, text),
    textInput: (className, maxLength, onCommit) => {
      const input = h('input', { type: 'text', class: className, maxLength, spellcheck: false, autocomplete: 'off', enterKeyHint: 'done', 'data-nav': true, 'data-key': 'exp-name' });
      input.addEventListener('change', () => onCommit(input.value));
      return input;
    },
    toggleRow: (label, get, set) => {
      const sw = toggleSwitch('exp-switch', label, get, set);
      const row = setRow(label, sw.el);
      row.classList.add('hud-settings-row');
      return { row, item: { el: sw.el, left: () => sw.el.click(), right: () => sw.el.click(), accept: () => sw.el.click() }, refresh: sw.refresh };
    },
    bindFocus: (el, item) => {
      // A row whose own field is the target (the preset's name): the field alone.
      if (el.querySelector('[data-nav]') !== null) return;
      el.setAttribute('data-nav', '');
      el.classList.add('mn-set-row-ctl');
      el.tabIndex = -1;
      ITEMS.set(el, item);
      if (item.left || item.right) onNavSide(el, () => item.left?.(), () => item.right?.());
      if (item.repeat === true) onNavRepeat(el);
      el.addEventListener('click', (e) => {
        if (e.target === el) item.accept?.();
      });
      el.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target === el && !e.repeat) {
          e.preventDefault();
          item.accept?.();
        }
      });
    },
    relayout,
  };
}
