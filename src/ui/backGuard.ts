/**
 * System Back (the UX audit's C2): Android's back gesture and button, an Android TV remote's BACK,
 * the browser's back button, Alt + ← and a mouse's back button all walk the page's history, which
 * took the player out of the site, mid-match too (a silent abandon, banned in Competitive). One
 * sentinel entry on top of the page's own catches them: pushState with the same URL (the hash flags,
 * #diag and the rest, stay), and its popstate becomes one step back inside the game (`onBack`: the
 * Game closes a modal, goes back one screen, pauses a match) before the sentinel is pushed again.
 * On the home screen the Game asks "Leave Turbogol?" and calls `release`: while that dialog is up
 * nothing is re-armed, so the next Back really leaves (the page before, or the system's own exit);
 * closing it calls `resume`. The GoBack / BrowserBack / XF86Back keys that some remotes and
 * keyboards send as keydowns are the same step; when such a key also walks the history, the
 * popstate within BACK_KEY_MS is that same press (one step, not two).
 *
 * One entry, re-armed after every Back, rather than one per screen: the history can never drift from
 * the menu stack (Esc / B pop screens without it, screens are replaced, matches start from any
 * screen), and a reload keeps it (the entry's state survives: `start` sees the marker and pushes
 * nothing). A Back onto an older marker (a reload's duplicate) is a step back too; a forward onto
 * one is nothing.
 *
 * Chrome skips, on Back, an entry left by a pushState made without a user activation (its history
 * manipulation intervention), and clears that mark at the page's next activation. So the first
 * sentinel waits for the first click, tap or key, and the one re-armed inside a popstate is
 * safe from the next touch or key on; two Backs in a row with nothing in between can still leave.
 * A controller press carries no activation: the Game still calls `arm` on the first one (a player
 * on the pad alone; at worst Back leaves, as it did before).
 * Pure logic over a BackWindow, so node tests drive a fake history (tests/back-guard.test.mjs).
 */

/** e.key of a "back" key: Android (GoBack), a keyboard's or a remote's browser key (BrowserBack), Tizen remotes (XF86Back). */
export const BACK_KEYS: ReadonlySet<string> = new Set(['GoBack', 'BrowserBack', 'XF86Back']);
/** A back key's popstate, when the browser also walks the history for it, arrives within this (ms). */
export const BACK_KEY_MS = 300;

/** The sentinel's history state: a number that grows with every push (older entries hold smaller ones). */
interface Marker {
  readonly turbogolBack: number;
}

function isMarker(s: unknown): s is Marker {
  return typeof s === 'object' && s !== null && typeof (s as { turbogolBack?: unknown }).turbogolBack === 'number';
}

/** What the guard uses of `window` (and of its history), injectable for node tests. */
export interface BackWindow {
  readonly history: {
    readonly state: unknown;
    readonly length: number;
    pushState(data: unknown, unused: string): void;
    back(): void;
  };
  addEventListener(type: string, listener: (e: Event) => void, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: string, listener: (e: Event) => void, options?: boolean | EventListenerOptions): void;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
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
  private started = false;
  private readonly win: BackWindow;
  private readonly onBack: () => void;

  constructor(win: BackWindow, onBack: () => void) {
    this.win = win;
    this.onBack = onBack;
  }

  /** Listen; an entry that already is a sentinel (a reload) is armed as it is. */
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
  }

  dispose(): void {
    if (!this.started) return;
    this.started = false;
    this.win.removeEventListener('popstate', this.onPop);
    this.win.removeEventListener('keydown', this.onKey, true);
    this.win.removeEventListener('pointerdown', this.onPointer, true);
    this.win.removeEventListener('pointerup', this.onPointer, true);
    this.cancelKey();
  }

  /** A sentinel is on top: the next Back stays in the game. */
  get active(): boolean {
    return this.armed && !this.held;
  }

  /** There is a page before the game's own entry (the leave dialog's LEAVE can go there). */
  get canLeave(): boolean {
    return this.win.history.length > 2;
  }

  /**
   * The leave dialog is up: the next Back leaves the page. When the sentinel is still on top (a
   * back key that walked no history) it is taken off with our own history.back().
   */
  release(): void {
    this.held = true;
    if (!this.armed) return;
    this.armed = false;
    this.ownPops++;
    this.win.history.back();
  }

  /** An input without a user activation (a controller button): put the first sentinel in anyway. */
  arm(): void {
    if (this.started) this.onActivation();
  }

  /** The leave dialog closed: Back stays in the game again. */
  resume(): void {
    if (!this.held) return;
    this.held = false;
    this.push();
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

  /** One step back inside the game, then the sentinel again (unless the step released it). */
  private step(): void {
    try {
      this.onBack();
    } finally {
      if (!this.held && !this.armed) this.push();
    }
  }

  private cancelKey(): boolean {
    if (this.keyTimer === 0) return false;
    this.win.clearTimeout(this.keyTimer);
    this.keyTimer = 0;
    return true;
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
    // Off the sentinel, onto the page's own entry: one step back, then re-armed.
    this.armed = false;
    this.seq = 0;
    if (this.held) return;
    this.step();
  };

  private readonly onKey = (e: Event): void => {
    const k = e as KeyboardEvent;
    if (isBackKey(k)) {
      e.preventDefault();
      if (k.repeat === true || this.held) return;
      // Wait for the popstate the browser may add for the same press; without one, step here.
      this.cancelKey();
      this.keyTimer = this.win.setTimeout(() => {
        this.keyTimer = 0;
        this.step();
      }, BACK_KEY_MS);
      return;
    }
    this.onActivation();
  };

  /** The events that carry a user activation: a mouse press, a finger or pen lifted (not put down). */
  private readonly onPointer = (e: Event): void => {
    const mouse = (e as PointerEvent).pointerType === 'mouse';
    if (mouse === (e.type === 'pointerdown')) this.onActivation();
  };

  /** A click, a tap or a key (a user activation): the first sentinel goes in now. */
  private readonly onActivation = (): void => {
    if (!this.armed && !this.held) this.push();
  };
}
