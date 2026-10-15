/**
 * Tiny DOM builder for the menus (src/ui): `h('div.card.big', { onclick }, child, 'text')`.
 * Class names after the tag (dot separated), attributes / properties / listeners in the second
 * argument (`on*` = listeners, `data-*` / `aria-*` = attributes, everything else a property),
 * children as nodes, strings or null / false (skipped). Nothing here runs per frame.
 */

export type Child = Node | string | number | null | undefined | false;

type Props = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(spec: K | `${K}.${string}`, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K];
export function h(spec: string, props?: Props | null, ...children: Child[]): HTMLElement {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length > 0) el.className = classes.join(' ');
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
      else if (k === 'class') el.className += (el.className ? ' ' : '') + String(v);
      else if (k.startsWith('data-') || k.startsWith('aria-') || k === 'role' || k === 'for' || k === 'tabindex') el.setAttribute(k, v === true ? '' : String(v));
      else (el as unknown as Record<string, unknown>)[k] = v;
    }
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: readonly Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

/** Replace every child of `el`. */
export function setChildren(el: Element, ...children: Child[]): void {
  el.textContent = '';
  append(el, children);
}

/** A focusable menu button (`data-nav`: spatial navigation target). */
export function navButton(cls: string, label: Child | Child[], onClick: () => void, extra?: Props): HTMLButtonElement {
  const kids = Array.isArray(label) ? label : [label];
  return h(`button.${cls.trim().replace(/\s+/g, '.')}` as 'button', { type: 'button', 'data-nav': true, onclick: (e: Event) => { e.preventDefault(); onClick(); }, ...extra }, ...kids);
}

/** 'm:ss' */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Copy text to the clipboard (best effort; false when the browser refuses). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
