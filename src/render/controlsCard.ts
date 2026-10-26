/**
 * The controls card (the UX audit's C3: nothing taught the controls, and boost on the left mouse
 * button / jump on the right one is not a guess anybody makes). It lists what a new player needs:
 * drive, steer, jump, boost and the ball cam, from the LIVE bindings of the device in use (a rebind
 * changes it), like the training key hints (Game.trainingHints).
 *
 *   matches     big during the kickoff countdown of the player's first CARD_FIRST_MATCHES matches
 *               (offline, server and P2P alike: the first countdown after the menus), then a slim
 *               strip in the corner from GO on, for CARD_STRIP_SECONDS of play
 *   free play   big from the start (every session: it is where the controls are learnt) until the
 *               car first moves, then the same strip
 *   touch       none: the on-screen buttons carry their names (JUMP, BOOST, DRIFT, CAM)
 *
 * The matches already shown are counted in localStorage (CARD_SEEN_KEY, the brand's prefix) when
 * the card comes up, so a match left during the countdown still counts. Pure (no DOM): the Game
 * drives a ControlsCardPlan with the match flow and builds the rows with controlsCardRows when the
 * device or a binding changes; Hud.setControlsCard draws them (style.css `.hud-controls`).
 */
import { STORAGE_PREFIX } from '../brand';
import { bindingLabel, type ActionId, type Binding, type Device } from '../input/bindings';
import { t, type Key } from '../i18n';

/** How many matches start with the big card. */
export const CARD_FIRST_MATCHES = 3;
/** Seconds of play (not paused, cars not frozen) the slim strip stays after the big card. */
export const CARD_STRIP_SECONDS = 60;
/** localStorage: how many matches showed the big card (a whole number). */
export const CARD_SEEN_KEY = STORAGE_PREFIX + 'controlsCard.v1';

/** 'full' the big card, 'strip' the slim corner strip, 'off' nothing. */
export type CardView = 'full' | 'strip' | 'off';

/** One control as the card draws it: a keycap, a mouse with the button lit, or a controller cap. */
export interface CardKey {
  readonly kind: 'key' | 'mouse' | 'pad';
  readonly label: string;
  /** 'mouse' only: MouseEvent.button (0 left, 1 middle, 2 right). */
  readonly button?: number;
}

export interface CardRow {
  readonly label: string;
  readonly keys: readonly CardKey[];
}

/** What the Hud draws: the rows, the tag next to the title and the line under the rows. */
export interface ControlsCardContent {
  readonly rows: readonly CardRow[];
  readonly tag: string;
  readonly foot: string;
}

/** The card's rows, in order: each one shows the bindings of its actions on the device. */
const CARD_ACTIONS: ReadonlyArray<{ readonly label: Key; readonly actions: readonly ActionId[] }> = [
  { label: 'controls.drive', actions: ['throttle', 'reverse'] },
  { label: 'controls.steer', actions: ['steerLeft', 'steerRight'] },
  { label: 'controls.jump', actions: ['jump'] },
  { label: 'controls.boost', actions: ['boost'] },
  { label: 'controls.ballCam', actions: ['ballCam'] },
];

/** Mouse buttons in words: 'LMB' (bindingLabel, the controls screen's) means nothing to a new player. */
const MOUSE_WORDS: Readonly<Record<number, Key>> = { 0: 'controls.mouseLeft', 1: 'controls.mouseMiddle', 2: 'controls.mouseRight' };

/** One binding as a card key (null: unbound). */
function cardKey(b: Binding | null): CardKey | null {
  if (b === null) return null;
  switch (b.kind) {
    case 'mouse': {
      const words = MOUSE_WORDS[b.button];
      return { kind: 'mouse', label: words !== undefined ? t(words) : bindingLabel(b), button: b.button };
    }
    case 'gpButton':
    case 'gpAxis':
      return { kind: 'pad', label: bindingLabel(b) };
    default:
      return { kind: 'key', label: bindingLabel(b) };
  }
}

/** 'L stick ←' → 'L stick': both directions of one stick become one cap. */
function stickName(label: string): string {
  return label.replace(/ [←→↑↓]$/, '');
}

/**
 * The card's rows for `device` from `binding` (Input.getBinding: the live profile). Two directions
 * of one stick merge into one cap ('L stick'); an unbound action is left out, a row with nothing
 * bound too. Allocates: call it when the device or a binding changes, not per frame.
 */
export function controlsCardRows(device: Device, binding: (action: ActionId, device: Device) => Binding | null): CardRow[] {
  const rows: CardRow[] = [];
  for (const row of CARD_ACTIONS) {
    const keys: CardKey[] = [];
    for (const action of row.actions) {
      const b = binding(action, device);
      const k = cardKey(b);
      if (k === null) continue;
      const prev = keys.at(-1);
      if (b !== null && b.kind === 'gpAxis' && prev !== undefined && prev.kind === 'pad' && stickName(prev.label) === stickName(k.label) && prev.label !== k.label) {
        keys[keys.length - 1] = { kind: 'pad', label: stickName(k.label) };
        continue;
      }
      if (prev !== undefined && prev.kind === k.kind && prev.label === k.label) continue;
      keys.push(k);
    }
    if (keys.length > 0) rows.push({ label: t(row.label), keys });
  }
  return rows;
}

/** Where the plan keeps the number of matches that showed the big card. */
export interface CardSeenStore {
  read(): number;
  write(n: number): void;
}

/** The browser's: localStorage under CARD_SEEN_KEY (no storage: 0, and nothing is kept). */
export const localCardSeen: CardSeenStore = {
  read() {
    try {
      const n = Number(window.localStorage.getItem(CARD_SEEN_KEY));
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    } catch {
      return 0;
    }
  },
  write(n) {
    try {
      window.localStorage.setItem(CARD_SEEN_KEY, String(n));
    } catch {
      /* storage unavailable: the count lives for this page only */
    }
  },
};

/**
 * When the card shows (the rules in this file's header). The Game calls `arm` whenever the menus
 * come up (the next countdown is a new match's first kickoff), `countdown` / `go` with the match
 * flow, `freePlay` / `drove` in free play, `tick` with the seconds of play and `clear` when the match
 * or the training ends; `view` is read every frame.
 */
export class ControlsCardPlan {
  private seenCount: number;
  private armed = false;
  private phase: CardView = 'off';
  private stripLeft = 0;
  private inFreePlay = false;
  /** Which match of the first ones the card belongs to (1-based; 0 in free play). */
  private matchNo = 0;
  private readonly store: CardSeenStore;

  constructor(store: CardSeenStore) {
    this.store = store;
    this.seenCount = store.read();
  }

  get view(): CardView {
    return this.phase;
  }

  /** Matches that showed the big card so far (stored). */
  get seen(): number {
    return this.seenCount;
  }

  /** The card's match among the first ones (1 = the very first), 0 in free play. */
  get match(): number {
    return this.matchNo;
  }

  /** The menus are up: no card, and the next countdown is a new match's first kickoff. */
  arm(): void {
    this.armed = true;
    this.inFreePlay = false;
    this.phase = 'off';
  }

  /** A kickoff countdown step: the first one of an armed match shows the big card while it is among the first ones. */
  countdown(): void {
    if (!this.armed) return;
    this.armed = false;
    if (this.seenCount >= CARD_FIRST_MATCHES) return;
    this.seenCount++;
    this.store.write(this.seenCount);
    this.matchNo = this.seenCount;
    this.phase = 'full';
  }

  /** GO: the big card becomes the strip. */
  go(): void {
    if (this.phase !== 'full' || this.inFreePlay) return;
    this.toStrip();
  }

  /** Free play started: the big card until the car moves (whatever the count: free play is for learning). */
  freePlay(): void {
    this.armed = false;
    this.inFreePlay = true;
    this.matchNo = 0;
    this.phase = 'full';
  }

  /** The player's car moved in free play: the big card becomes the strip. */
  drove(): void {
    if (this.phase === 'full' && this.inFreePlay) this.toStrip();
  }

  /** `dt` seconds of play (the Game passes 0 while paused or frozen): the strip runs out. */
  tick(dt: number): void {
    if (this.phase !== 'strip' || !(dt > 0)) return;
    this.stripLeft -= dt;
    if (this.stripLeft <= 0) this.phase = 'off';
  }

  /** The match or the training ended: no card (and no armed countdown until the menus come back). */
  clear(): void {
    this.armed = false;
    this.inFreePlay = false;
    this.phase = 'off';
  }

  private toStrip(): void {
    this.phase = 'strip';
    this.stripLeft = CARD_STRIP_SECONDS;
  }
}
