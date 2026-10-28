/**
 * The pause keys (the UX audit's C1), pure so node tests pin them (tests/pause-keys.test.mjs):
 * what Esc / Start / Backspace / pad B do in a match (Game.processActions) and the key line under
 * PAUSED (Hud). Nothing here quits: B is boost and "close this" on a controller, Backspace is free
 * play's reset ball, and a reflex press used to leave the match at once (online, in Competitive
 * too: an abandon and a ban). Only the pause menu's QUIT button leaves, with its second press online.
 */

/** 'toggle' pause on / off, 'resume' the paused match, 'menu' the pause menu's own edges (focus, accept), null nothing. */
export type PauseKeyAction = 'toggle' | 'resume' | 'menu' | null;

/**
 * This frame's pause decision from Input's edges: `pause` the pause binding's edge (Esc / Start;
 * it carries `back` too), `back` a back edge (Esc, Backspace, pad B), `paused` the match is paused,
 * `dropPause` this pause edge is the Escape of a pointer-lock release that already paused the game
 * (Game: UNLOCK_PAUSE_WINDOW; never a pad Start). A bare back edge resumes, like the pause key.
 */
export function pauseKeyAction(pause: boolean, back: boolean, paused: boolean, dropPause: boolean): PauseKeyAction {
  if (pause && !dropPause) return 'toggle';
  // The dropped Escape still has `pause` set: it does not resume either.
  if (back && !pause && paused) return 'resume';
  return paused ? 'menu' : null;
}

/**
 * The resume keys for the pause menu's key line: the pause bindings and the fixed back keys that
 * resume too (Esc, pad B; Backspace as well, left out of the line), each once: 'Esc / Start / B'.
 * An unbound label ('—') is skipped.
 */
export function pauseResumeKeys(kbmPause: string, padPause: string): string {
  const keys: string[] = [];
  for (const k of [kbmPause, 'Esc', padPause, 'B']) if (k !== '—' && !keys.includes(k)) keys.push(k);
  return keys.join(' / ');
}
