/**
 * System Back (the UX audit's C2): Android's back gesture and button, a TV remote's BACK, the
 * browser's back button, Alt + ← and a mouse's back button took the player out of the site,
 * mid-match too (a silent abandon, banned in Competitive). Two catchers turn each into one step
 * inside the game (`onBack`: the Game closes a modal, goes back one screen, pauses a match):
 *
 * - A CloseWatcher, where there is one (Chromium 120+, where Android's Back, an Android TV remote's
 *   BACK included, is a close request): one is kept alive, its `close` is the step, and a new one
 *   comes a task later. A page may hold one without any user activation (the close watcher
 *   manager's first group is free), so it holds for any number of Backs in a row, a
 *   controller-only player's too (headless Edge: re-made after each close, it took 4 of 4 close
 *   requests with no activation). Esc on a keyboard is a close request too: a close inside an
 *   Escape keydown is that key's own (Chromium closes synchronously in the keydown's default
 *   action, after the Game's listeners already handled the Esc), so it is no second step.
 * - One sentinel history entry on top of the page's own, for the Backs that walk the history (the
 *   browser's toolbar, Alt + ←, a mouse's back button, Android's Back without CloseWatcher):
 *   pushState with the same URL (the hash flags, #diag and the rest, stay); its popstate is the
 *   step, then the sentinel is pushed again.
 *
 * On the home screen the Game asks "Leave Turbogol?" and calls `release`: while that dialog is up
 * neither catcher is armed, so the next Back really leaves (the page before, or the system's own
 * exit); closing it calls `resume`. The GoBack / BrowserBack / XF86Back keys that some remotes and
 * keyboards send as keydowns are the same step (cancelled, so the browser walks nothing); when a
 * browser walks the history for one anyway, the popstate within BACK_KEY_MS is that same press
 * (one step, not two). While the dialog is up such a key is not cancelled: the browser's Back
 * runs, and a key-only remote's (no popstate, beforeunload or pagehide within BACK_KEY_MS) leaves
 * here (`exit`).
 *
 * One entry, re-armed after every Back, rather than one per screen: the history can never drift from
 * the menu stack (Esc / B pop screens without it, screens are replaced, matches start from any
 * screen), and a reload keeps it (the entry's state survives: `start` sees the marker and pushes
 * nothing). A Back onto an older marker (a reload's duplicate) is a step back too; a forward onto
 * one is nothing.
 *
 * Chromium and WebKit skip, on a Back from their own UI, the entry under a pushState made without
 * a user activation (the history manipulation intervention), until the page's next click, tap or
 * key clears the mark. So the first sentinel waits for one (Esc and the modifier keys do not
 * activate), and the one pushed again inside a popstate (or by a controller press, `arm`, or by
 * `resume`) is skipped until then: a second history Back with nothing in between still leaves in
 * those browsers, exactly as it would with no sentinel at all, while Firefox (no such skip) stays.
 * Android's Back does not go through the history there (the CloseWatcher takes it); the rest is
 * the Game's beforeunload backstop in a match (Game.updateLeaveGuard).
 * Pure logic over a BackWindow, so node tests drive a fake history and close watchers
 * (tests/back-guard.test.mjs).
 */

/** e.key of a "back" key: Android (GoBack), a keyboard's or a remote's browser key (BrowserBack), Tizen remotes (XF86Back). */
export const BACK_KEYS: ReadonlySet<string> = new Set(['GoBack', 'BrowserBack', 'XF86Back']);
/** A back key's popstate, when the browser also walks the history for it, arrives within this (ms). */
export const BACK_KEY_MS = 300;
/** e.key values whose keydown is no user activation (Esc by the HTML spec; a modifier alone, to be safe). */
const NO_ACTIVATION_KEYS: ReadonlySet<string> = new Set(['Escape', 'Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock', 'Fn']);

/** The sentinel's history state: a number that grows with every push (older entries hold smaller ones). */
interface Marker {
  readonly turbogolBack: number;
}

function isMarker(s: unknown): s is Marker {
  return typeof s === 'object' && s !== null && typeof (s as { turbogolBack?: unknown }).turbogolBack === 'number';
}

/** What the guard uses of a CloseWatcher (duck-typed: not every DOM lib declares it). */
interface CloseWatcherLike {
  addEventListener(type: 'close', listener: () => void): void;
  destroy(): void;
}

/** What the guard uses of `window` (and of its history), injectable for node tests. */
export interface BackWindow {
  readonly history: {
    readonly state: unknown;
    readonly length: number;
    pushState(data: unknown, unused: string): void;
    back(): void;
  };
  /** The CloseWatcher constructor, where the browser has one. */
  readonly CloseWatcher?: unknown;
  addEventListener(type: string, listener: (e: Event) => void, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: string, listener: (e: Event) => void, options?: boolean | EventListenerOptions): void;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  close?(): void;
}

interface KeyLike {
  readonly key?: unknown;
  readonly code?: unknown;
  readonly repeat?: unknown;
}

/** A keydown that means Back (BACK_KEYS by e.key, or the BrowserBack code). */
export function isBackKey(e: KeyLike): boolean {
  return (typeof e.key === 'string' && BACK_KEYS.has(e.key)) || e.code === 'BrowserBack';
}

export class BackGuard {
  /** The current entry is a sentinel of ours. */
  private armed = false;
  /** Released (the leave dialog is up): nothing re-arms until `resume`. */
  private held = false;
  /** Marker number of the current entry while armed, and the highest one pushed. */
  private seq = 0;
  private top = 0;
  /** Popstates of our own history.back() (release) still to come. */
  private ownPops = 0;
  /** A back key waiting BACK_KEY_MS for its popstate (0 = none). */
  private keyTimer = 0;
  /** The live close watcher (null: none yet, released, or no CloseWatcher in this browser). */
  private watcher: CloseWatcherLike | null = null;
  /** The next close watcher, a task after the last one closed (0 = none due). */
  private watchTimer = 0;
  /** Inside an Escape keydown (until its task ends): a close request now is that key's. */
  private escDown = false;
  private started = false;
  private readonly win: BackWindow;
  private readonly onBack: () => void;

  constructor(win: BackWindow, onBack: () => void) {
    this.win = win;
    this.onBack = onBack;
  }

  /** Listen, and watch for close requests; an entry that already is a sentinel (a reload) is armed as it is. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const st = this.state();
    if (isMarker(st)) {
      this.armed = true;
      this.seq = this.top = st.turbogolBack;
    }
    this.win.addEventListener('popstate', this.onPop);
    this.win.addEventListener('keydown', this.onKey, true);
    this.win.addEventListener('pointerdown', this.onPointer, { capture: true, passive: true });
    this.win.addEventListener('pointerup', this.onPointer, { capture: true, passive: true });
    this.win.addEventListener('pagehide', this.onGone);
    this.watch();
  }

  dispose(): void {
    if (!this.started) return;
    this.started = false;
    this.win.removeEventListener('popstate', this.onPop);
    this.win.removeEventListener('keydown', this.onKey, true);
    this.win.removeEventListener('pointerdown', this.onPointer, true);
    this.win.removeEventListener('pointerup', this.onPointer, true);
    this.win.removeEventListener('pagehide', this.onGone);
    this.cancelKey();
    this.unwatch();
  }

  /** The next Back stays in the game (a close watcher or a sentinel is up). */
  get active(): boolean {
    return !this.held && (this.armed || this.watcher !== null);
  }

  /** There is a page before the game's own entry (the leave dialog's LEAVE can go there). */
  get canLeave(): boolean {
    return this.win.history.length > 2;
  }

  /**
   * The leave dialog is up: the next Back leaves the page. The close watcher goes; when the
   * sentinel is still on top (a close request or a back key, which walk no history) it is taken
   * off with our own history.back().
   */
  release(): void {
    this.held = true;
    this.unwatch();
    if (!this.armed) return;
    this.armed = false;
    this.ownPops++;
    this.win.history.back();
  }

  /**
   * A controller press (no user activation): put the first sentinel in anyway. Where the browser
   * skips it (see the header) a Back leaves as it would without it; where it does not, it holds.
   */
  arm(): void {
    if (this.started) this.onActivation();
  }

  /** The leave dialog closed: Back stays in the game again. */
  resume(): void {
    if (!this.held) return;
    this.held = false;
    this.push();
    this.watch();
  }

  /** LEAVE in the dialog (released, on the page's own entry): back to the page before. */
  leave(): void {
    this.held = true;
    this.win.history.back();
  }

  private state(): unknown {
    try {
      return this.win.history.state;
    } catch {
      return null;
    }
  }

  /** Put a sentinel on top (nothing when the current entry is one already). */
  private push(): void {
    const st = this.state();
    if (isMarker(st)) {
      this.armed = true;
      this.seq = st.turbogolBack;
      if (this.seq > this.top) this.top = this.seq;
      return;
    }
    try {
      const marker: Marker = { turbogolBack: ++this.top };
      this.win.history.pushState(marker, '');
      this.armed = true;
      this.seq = marker.turbogolBack;
    } catch {
      /* a sandboxed frame without history: Back behaves as the browser's */
    }
  }

  /** A close watcher up, unless one is, the guard is released or stopped, or the browser has none. */
  private watch(): void {
    if (!this.started || this.held || this.watcher !== null) return;
    const Ctor = this.win.CloseWatcher;
    if (typeof Ctor !== 'function') return;
    try {
      const w = new (Ctor as new () => CloseWatcherLike)();
      w.addEventListener('close', () => this.onClose(w));
      this.watcher = w;
    } catch {
      /* not allowed here (an inactive document): the sentinel alone */
    }
  }

  private unwatch(): void {
    if (this.watchTimer !== 0) {
      this.win.clearTimeout(this.watchTimer);
      this.watchTimer = 0;
    }
    const w = this.watcher;
    if (w === null) return;
    this.watcher = null;
    try {
      w.destroy();
    } catch {
      /* already gone */
    }
  }

  /** One step back inside the game, then the sentinel again when the history walked off it (unless the step released it). */
  private step(): void {
    try {
      this.onBack();
    } finally {
      if (!this.held && !this.armed) this.push();
    }
  }

  private cancelKey(): void {
    this.win.removeEventListener('beforeunload', this.onGone);
    if (this.keyTimer === 0) return;
    this.win.clearTimeout(this.keyTimer);
    this.keyTimer = 0;
  }

  /**
   * `fn` in BACK_KEY_MS, unless a popstate or a close request is the same press first, or the page
   * goes for it: pagehide, and with `leaving` beforeunload too (a cross-document Back may take
   * longer than BACK_KEY_MS to unload; listened to only meanwhile, as it can cost the page its
   * back/forward cache in some browsers).
   */
  private waitKey(fn: () => void, leaving: boolean): void {
    this.cancelKey();
    if (leaving) this.win.addEventListener('beforeunload', this.onGone);
    this.keyTimer = this.win.setTimeout(() => {
      this.keyTimer = 0;
      this.win.removeEventListener('beforeunload', this.onGone);
      fn();
    }, BACK_KEY_MS);
  }

  /**
   * A back key while the leave dialog is up whose Back the browser did not run: out of the game,
   * to the page before, or (the game is the tab's first page: a TV launcher, a PWA) the window
   * closes where a script may close it.
   */
  private exit(): void {
    this.held = true;
    if (this.canLeave) {
      this.win.history.back();
      return;
    }
    try {
      this.win.close?.();
    } catch {
      /* not closable by a script: the system's own Back still leaves */
    }
  }

  /** A close request (Android's Back, a remote's BACK, Esc): one step, unless it is an Escape keydown's; a new watcher a task later. */
  private onClose(w: CloseWatcherLike): void {
    if (this.watcher !== w) return;
    this.watcher = null;
    // A back keydown for the same press (a browser that sends both) is this step.
    this.cancelKey();
    try {
      if (!this.escDown && !this.held) this.onBack();
    } finally {
      if (this.started && !this.held && this.watchTimer === 0) {
        this.watchTimer = this.win.setTimeout(() => {
          this.watchTimer = 0;
          this.watch();
        }, 0);
      }
    }
  }

  private readonly onPop = (e: Event): void => {
    // A back key's own history walk: the popstate is that press (the timer would make it two).
    this.cancelKey();
    if (this.ownPops > 0) {
      this.ownPops--;
      this.armed = false;
      return;
    }
    const st = (e as PopStateEvent).state;
    if (isMarker(st)) {
      // Onto a sentinel: back from a newer one is a step, forward onto it is nothing.
      const back = st.turbogolBack < this.seq;
      this.armed = true;
      this.seq = st.turbogolBack;
      if (back && !this.held) this.step();
      return;
    }
    // A join link typed or opened in this tab (#sala=ABC234: screens/lobby.ts installJoinLink) is a
    // navigation to it, not a Back.
    if (typeof location !== 'undefined' && /(?:^#|&)sala=/.test(location.hash)) return;
    // Off the sentinel, onto the page's own entry: one step back, then re-armed.
    this.armed = false;
    this.seq = 0;
    if (this.held) return;
    this.step();
  };

  private readonly onKey = (e: Event): void => {
    const k = e as KeyboardEvent;
    if (isBackKey(k)) {
      if (this.held) {
        // "Press Back again to leave": the key's own Back is not cancelled; a key that walks no
        // history (a key-only remote) leaves here.
        if (k.repeat !== true) this.waitKey(() => this.exit(), true);
        return;
      }
      e.preventDefault();
      if (k.repeat === true) return;
      // Wait for the popstate the browser may add for the same press; without one, step here.
      this.waitKey(() => this.step(), false);
      return;
    }
    if (k.key === 'Escape') {
      // The close request an unhandled Esc makes comes in this keydown's default action.
      this.escDown = true;
      this.win.setTimeout(() => {
        this.escDown = false;
      }, 0);
      return;
    }
    if (typeof k.key === 'string' && NO_ACTIVATION_KEYS.has(k.key)) return;
    this.onActivation();
  };

  /** The events that carry a user activation: a mouse press, a finger or pen lifted (not put down). */
  private readonly onPointer = (e: Event): void => {
    const mouse = (e as PointerEvent).pointerType === 'mouse';
    if (mouse === (e.type === 'pointerdown')) this.onActivation();
  };

  /** The page is going (a back key's own Back): a pending key timer must not leave a second time (or on a return from the back/forward cache). */
  private readonly onGone = (): void => {
    this.cancelKey();
  };

  /** A click, a tap or a key (a user activation): the first sentinel goes in now. */
  private readonly onActivation = (): void => {
    if (!this.armed && !this.held) this.push();
  };
}
