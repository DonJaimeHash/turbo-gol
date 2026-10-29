/**
 * `#keys` (plan PR 14): what a device's keys really send, on screen, for checking a real TV's remote
 * (its BACK, CH+ / CH−, OK, the colour keys) and its system keyboard: every keydown / keyup with its
 * `key`, `code` and `keyCode` (capture phase, before the game sees it; nothing is taken), the text
 * inputs (`inputType`, `data`: a system keyboard often sends keyCode 229 and an input event instead)
 * and the history's popstate (a BACK that the browser turned into a step back). The last 14, newest
 * first, at the top right; it takes no pointer and no focus. A password field's characters show as
 * dots, and so do a keyboard's while the keypad is up over a password (its focus is on a key, not the
 * field: mn-keypad[data-masked]). Installed by main.ts for the page load.
 */
const KEEP = 14;

export function installKeysOverlay(): void {
  const box = document.createElement('pre');
  // Inline: a diagnostic that costs the shipped stylesheet nothing.
  box.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483000;max-width:min(36rem,90vw);margin:0;padding:8px 10px;color:var(--brand);font:13px/1.35 ui-monospace,Consolas,monospace;white-space:pre-wrap;background:var(--ink);border:1px solid var(--edge-hi);pointer-events:none';
  box.setAttribute('aria-hidden', 'true');
  const lines: string[] = [];
  const add = (line: string): void => {
    lines.unshift(line);
    lines.length = Math.min(lines.length, KEEP);
    box.textContent = lines.join('\n');
  };
  const secret = (e: Event): boolean => (e.target instanceof HTMLInputElement && e.target.type === 'password') || document.querySelector('.mn-keypad[data-masked]') !== null;
  const key = (e: KeyboardEvent): void => {
    const k = secret(e) && typeof e.key === 'string' && e.key.length === 1 ? '•' : e.key;
    add(`${e.type === 'keydown' ? 'down' : 'up  '} key=${JSON.stringify(k)} code=${JSON.stringify(secret(e) ? '' : e.code)} keyCode=${secret(e) ? 0 : e.keyCode}${e.repeat ? ' repeat' : ''}`);
  };
  window.addEventListener('keydown', key, true);
  window.addEventListener('keyup', key, true);
  window.addEventListener('input', (e) => add(`input ${(e as InputEvent).inputType ?? ''} data=${secret(e) ? '•' : JSON.stringify((e as InputEvent).data ?? null)}`), true);
  window.addEventListener('popstate', () => add(`popstate (history back) ${location.hash}`), true);
  box.textContent = '#keys';
  document.body.appendChild(box);
}
