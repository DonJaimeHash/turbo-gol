/**
 * Toasts (`mn-toast`, plan §1.3): an icon and a line, at most 3 at a time (the oldest goes first),
 * each up for 1.5 s plus 60 ms a character, 4 to 10 s. Info and success are polite live regions,
 * an error an assertive one. A toast never asks for anything: an error that needs an action is a
 * sheet (Menu.modal). Built on call, nothing at import.
 */
import { h } from '../dom';
import { icon } from './icons';
import type { IconName } from './icons';

export type ToastKind = 'info' | 'error' | 'ok';

const MAX = 3;
const OUT_MS = 300; // --dur-toast-out

/** How long a toast of `text` stays up (ms). Pure. */
export function toastMs(text: string): number {
  return Math.min(10_000, Math.max(4_000, 1_500 + 60 * text.length));
}

const ICONS: Record<ToastKind, IconName> = { info: 'info', error: 'warning', ok: 'check' };

export class Toasts {
  readonly el: HTMLElement;

  constructor() {
    this.el = h('div.mn-toasts');
  }

  show(text: string, kind: ToastKind = 'info'): void {
    const live = this.el.querySelectorAll('.mn-toast:not(.mn-toast-out)');
    if (live.length >= MAX) this.drop(live[0] as HTMLElement);
    const t = h(`div.mn-toast.mn-toast-${kind}` as 'div', { role: kind === 'error' ? 'alert' : 'status', 'aria-live': kind === 'error' ? 'assertive' : 'polite' }, icon(ICONS[kind], 'mn-toast-icon'), h('span', null, text));
    this.el.appendChild(t);
    window.setTimeout(() => this.drop(t), toastMs(text));
  }

  private drop(t: HTMLElement): void {
    if (t.classList.contains('mn-toast-out')) return;
    t.classList.add('mn-toast-out');
    window.setTimeout(() => t.remove(), OUT_MS);
  }
}
