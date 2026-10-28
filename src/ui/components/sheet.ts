/**
 * A sheet (`mn-sheet`, plan §1.3), the menus' one dialog (Menu.modal mounts it): a title, a body
 * and a row of actions, centred on a PC or a TV (560 wide at most, opaque, the --veil behind),
 * rising from the bottom on a phone (90 % of the height at most). Menu.modal makes it modal
 * (aria-modal, the rest inert, Back closes it, the focus goes back to its opener). The first
 * action, or the one marked `autofocus` (CANCEL in a destructive sheet), takes the focus.
 * Built on call, nothing at import.
 */
import { h } from '../dom';
import type { Child } from '../dom';

export interface SheetAction {
  label: string;
  /** The lime one (one per sheet at most). */
  primary?: boolean;
  /** Leave, kick, delete: the --danger outline (.mn-btn-cancel). */
  danger?: boolean;
  /** Takes the first focus (else the first action). */
  autofocus?: boolean;
  /** False keeps the sheet up; anything else closes it. */
  onClick: () => void | boolean | Promise<void | boolean>;
}

export interface SheetSpec {
  title: string;
  body: Child | Child[];
  actions: SheetAction[];
  /** Esc / B / Back close it (default true). */
  dismissable?: boolean;
  /** Called once when it closes, however (an action, Back, another sheet, the menus hiding). */
  onClose?: () => void;
}

/** The sheet's box; `done` runs after an action that did not return false. */
export function sheetBox(spec: SheetSpec, done: () => void): HTMLElement {
  const actions = h('div.mn-sheet-actions', { 'data-nav-row': true });
  for (const a of spec.actions) {
    const cls = a.primary ? '.mn-btn-primary' : a.danger ? '.mn-btn-cancel' : '';
    const b = h(`button.mn-btn${cls}` as 'button', { type: 'button', 'data-nav': true, 'data-autofocus': a.autofocus === true }, a.label);
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const r = await a.onClick();
        if (r !== false) done();
      } finally {
        b.disabled = false;
      }
    });
    actions.appendChild(b);
  }
  const body = Array.isArray(spec.body) ? spec.body : [spec.body];
  return h('div.mn-sheet', { role: 'dialog', 'aria-modal': 'true', 'aria-label': spec.title }, h('div.mn-sheet-title', null, spec.title), h('div.mn-sheet-body', null, ...body), actions);
}
