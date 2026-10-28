/**
 * DOM HUD (the Tablero plan PR 7; the owner's hub-partido-pc): the scorebug (top left, in the
 * order TAG n │ clock │ n TAG, a lime notch under the player's team, the network bars by the
 * clock online), the boost plate (bottom left, the speed readout above it in debug mode), fps,
 * camera mode, the off-screen ball indicator (kept off the HUD's plates), the countdown (with the
 * overtime line over it), the centre for ¡GOOOL! (the scoring team's slab and the scorer's chip)
 * and the final whistle only, a feed of at most two chips at the top (joined, left, a bot takes
 * over, DEMOLIDO), the pause as a dock (FocusNav, PARTIDO EN JUEGO online, SALIR held), the Tab
 * scoreboard and a pointer-lock hint. Ajustes is src/ui/screens/settings (over the pause too: its
 * overlay hides the dock, setPauseCovered). Every per-frame setter caches its last value and
 * touches the DOM only when something changed, so calling them every frame costs nothing and
 * allocates nothing.
 *
 * The controls card (bottom right, src/render/controlsCard.ts: the first matches' kickoff countdown
 * and free play, then a slim strip) is drawn by `setControlsCard` from rows the Game builds.
 *
 * Debug readouts (speed, fps / draw calls / GPU time) are hidden by default; F3 toggles them,
 * and `#stats` or `#debug` in the URL shows them from the start.
 *
 * The pause dock is driven by the Game (`pauseAction`, from Input's menu edges: keyboard and pad
 * alike, onto src/ui/nav.ts FocusNav), since the pause / back keys it shares with the match are
 * Input's. The Hud's own keys are F3 and F4.
 *
 * Styling lives in src/style.css (classes prefixed `hud-`).
 */
import { PEER_CAND_LABELS, PEER_STATE_LABELS, type NetStatsView } from '../net/NetStats';
import { isNodeHost } from '../net/protocol';
import type { GameMode } from '../sim/constants';
import { t } from '../i18n';
import { pageFlags } from './hashFlags';
import type { CardKey, CardView, ControlsCardContent } from './controlsCard';
import { pauseResumeKeys } from '../game/pauseKeys';
import { DEFAULT_MATCH_SECONDS, formatClockSeconds } from '../game/Match';
import { FocusNav } from '../ui/nav';

// The sliders' maths and the Graphics list's step moved with Ajustes (src/ui/screens/settings/model.ts);
// tests/hud-menu.test.mjs reads them here.
export { choiceStep, experimentalTabLabel, formatSettingValue, stepDecimals, stepSettingValue } from '../ui/screens/settings/model';

export type Difficulty = 'easy' | 'medium' | 'hard';
export const DIFFICULTIES: readonly Difficulty[] = ['easy', 'medium', 'hard'];
/** Menu order of the game modes (every key of MODES). */
export const GAME_MODES: readonly GameMode[] = ['1v1', '2v2', '3v3'];

/** How the clock is displayed: counting down, counting up (unlimited match) or overtime (+m:ss, red). */
export type ClockMode = 'regulation' | 'unlimited' | 'overtime';

/** An online session's kind: 'p2p' = the mesh (phase 2), 'server' = a server match (phase 1). */
export type OnlineKind = 'p2p' | 'server';

/** The network bars by the clock (3 good, 1 poor) from the round trip and the loss; 0: nothing to show yet. */
export function netBars(rttMs: number, lossPct: number): 0 | 1 | 2 | 3 {
  if (!(rttMs > 0)) return 0;
  if (rttMs >= 200 || lossPct >= 8) return 1;
  if (rttMs >= 110 || lossPct >= 3) return 2;
  return 3;
}

/** A box on the HUD (CSS px of its root) the ball indicator stays out of. */
export interface HudRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Where the ball indicator goes when (x, y) falls inside one of `rects` grown by `r` (the glyph's
 * reach): out along the shortest way that stays on the `w` x `h` screen, else where it was. Pure;
 * writes `out` (no allocation per frame).
 */
export function avoidRects(x: number, y: number, r: number, rects: readonly HudRect[], w: number, h: number, out: { x: number; y: number }): void {
  out.x = x;
  out.y = y;
  for (const b of rects) {
    const l = b.left - r;
    const tp = b.top - r;
    const rt = b.right + r;
    const bt = b.bottom + r;
    if (out.x <= l || out.x >= rt || out.y <= tp || out.y >= bt) continue;
    let best = Infinity;
    let nx = out.x;
    let ny = out.y;
    const tryAt = (cx: number, cy: number): void => {
      if (cx < r || cx > w - r || cy < r || cy > h - r) return;
      const d = Math.abs(cx - out.x) + Math.abs(cy - out.y);
      if (d < best) {
        best = d;
        nx = cx;
        ny = cy;
      }
    };
    tryAt(l, out.y);
    tryAt(rt, out.y);
    tryAt(out.x, tp);
    tryAt(out.x, bt);
    out.x = nx;
    out.y = ny;
  }
}

/**
 * Menu status string of the online flow's anti-bot step (Turnstile in front of POST /api/guest):
 * OnlineSession shows `verifying` while the widget is up. A failed check (NetError 'turnstile')
 * reads as error.queue.turnstile_* (src/net/netErrorText.ts).
 */
export const ONLINE_STATUS = {
  verifying: t('online.verifying'),
} as const;

/**
 * One entry of the pause menu (setPaused): RESUME, SETTINGS, QUIT, and the training entries in
 * between. The Game builds the list; the Hud draws it and moves the focus.
 */
export interface PauseEntry {
  /** Stable id ('resume', 'settings', 'quit'...): setPauseCovered(false, id) focuses it again. */
  readonly id: string;
  /** The button text, read again after every activation (a toggle changes it). */
  readonly label: () => string;
  /**
   * 'primary': RESUME's lime look; 'quit': the red edge; 'row': a smaller button on a shared row
   * (training), one focus stop for the row (left / right pick); default: a plain wide button.
   */
  readonly kind?: 'primary' | 'quit' | 'row';
  /**
   * Leaving a match: held for HOLD_MS (A / Enter, a finger) or double-clicked with a mouse; a
   * plain press or click only says how (the plan's mn-hold, pause.holdHint).
   */
  readonly hold?: boolean;
  /** A line under the label (QUIT in Competitivo: it counts as an abandon). */
  readonly sub?: () => string | null;
  /** `mouse`: a real mouse click picked it (the Game captures the mouse again on a resume). */
  readonly select: (mouse: boolean) => void;
}

/** How long QUIT is held (plan §1.7: 1000 ms to leave). */
export const HOLD_MS = 1000;

/** The feed: chips at once, and how long each stays. */
const FEED_MAX = 2;
const FEED_MS = 2500;

/** How far the ball indicator's glyph reaches round its point (the dot, its arrow and its distance). */
const IND_REACH = 34;

/** The last input was a finger (device.ts: touch draws no ring, focuses nothing). */
function touchMode(): boolean {
  return document.documentElement.classList.contains('tg-touch');
}

/** A real mouse click (not a tap, not a key / pad activation through `.click()`). */
function isMouseClick(e: MouseEvent): boolean {
  if (!e.isTrusted) return false;
  const type = (e as Partial<PointerEvent>).pointerType;
  return type !== undefined ? type === 'mouse' : e.detail > 0;
}

/** What the pause menu takes from the Game: Input's menu edges (keyboard and pad). */
export type PauseAction = 'up' | 'down' | 'left' | 'right' | 'accept';

/** One car on the Tab scoreboard. */
export interface ScoreboardRow {
  name: string;
  team: 0 | 1;
  /** The human's car: 'YOU' tag. */
  you: boolean;
  /** 'BOT' tag (default true for every other car); false = a remote human (online). */
  bot?: boolean;
}

/**
 * Data for the Tab scoreboard. Reuse one object per frame: the Hud compares field by field (the
 * `rows` are compared by content, so an in-place refill is fine too).
 */
export interface ScoreboardData {
  blue: number;
  red: number;
  /** Preformatted clock text (e.g. '3:21' or '+0:42'). */
  clock: string;
  difficulty: string;
  /** Game mode for the footer ('3v3'). */
  mode?: string;
  /** Every car, any order (listed under its team). Without it the two legacy fields below make two rows. */
  rows?: readonly ScoreboardRow[];
  playerName?: string;
  botName?: string;
  /** Which team the human plays on (default 0 = blue). */
  playerTeam?: 0 | 1;
}

export class Hud {
  readonly root: HTMLElement;

  /** Labels the per-frame / per-event setters swap in, translated once here (never t() per frame). */
  private readonly labelBallCam = t('hud.ballCam');
  private readonly labelCarCam = t('hud.carCam');
  private readonly labelGo = t('hud.go');
  private readonly labelYou = t('hud.you');
  private readonly labelBot = t('hud.bot');

  private readonly scoreBlue: HTMLElement;
  private readonly scoreRed: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly scoreBox: HTMLElement;
  /** The network bars by the clock (online; netBars). */
  private readonly netBarsEl: HTMLElement;
  private lastBars = -1;
  private lastTeam = -1;
  private readonly boostValue: HTMLElement;
  private readonly boostFill: HTMLElement;
  private readonly boostBox: HTMLElement;
  private readonly speedValue: HTMLElement;
  private readonly speedBox: HTMLElement;
  private readonly fps: HTMLElement;
  private readonly fpsInfo: HTMLElement;
  private readonly camMode: HTMLElement;
  private readonly ballInd: HTMLElement;
  private readonly ballIndArrow: HTMLElement;
  private readonly ballIndDist: HTMLElement;
  /** The plates the ball indicator stays out of (measured on a resize and as the controls card comes and goes). */
  private readonly indRects: HudRect[] = [];
  private indRectsKey = '';
  private readonly indAt = { x: 0, y: 0 };
  private readonly countdown: HTMLElement;
  /** TIEMPO EXTRA over the overtime kickoff's countdown (showOvertime). */
  private readonly countdownCaption: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly bannerTitle: HTMLElement;
  private readonly bannerSub: HTMLElement;
  /** ¡GOOOL!: the scoring team's slab, the scorer's chip under it. */
  private readonly goal: HTMLElement;
  private readonly goalChip: HTMLElement;
  private goalTimer = 0;
  /** The feed (top centre): at most FEED_MAX chips, each FEED_MS. */
  private readonly feedEl: HTMLElement;
  private readonly paused: HTMLElement;
  private readonly pausedTitle: HTMLElement;
  private readonly pausedLive: HTMLElement;
  private readonly pausedSub: HTMLElement;
  /** The pause dock's buttons (setPaused rebuilds them from the Game's entries). */
  private readonly pauseMenu: HTMLElement;
  /** Spatial focus over the dock (src/ui/nav.ts), driven by pauseAction. */
  private readonly pauseNav: FocusNav;
  private pauseOpen = false;
  /** The settings screen is open over the pause menu (setPauseCovered). */
  private pauseCovered = false;
  private pauseEntries: readonly PauseEntry[] = [];
  /** One button per entry, in entry order. */
  private readonly pauseButtons: HTMLButtonElement[] = [];
  /** The held entry (PauseEntry.hold), its timer and its button's fill. */
  private holding: PauseEntry | null = null;
  private holdTimer = 0;
  /** The hold came from A / Enter: the Game ends it when they are let go (pauseHoldRelease). */
  private holdByKey = false;
  private readonly hint: HTMLElement;
  private readonly controls: HTMLElement;
  private readonly controlsTag: HTMLElement;
  private readonly controlsRows: HTMLElement;
  private readonly controlsFoot: HTMLElement;
  private controlsView: CardView = 'off';
  private controlsContent: ControlsCardContent | null = null;

  // Scoreboard (Tab).
  private readonly scoreboard: HTMLElement;
  private readonly sbBlue: HTMLElement;
  private readonly sbRed: HTMLElement;
  private readonly sbClock: HTMLElement;
  /** Row containers per team and the rows currently in the DOM (content cache for the diff). */
  private readonly sbRowsEl: readonly [HTMLElement, HTMLElement];
  private readonly sbShown: ScoreboardRow[] = [];
  /** Rows synthesised from the legacy playerName / botName fields (refilled in place). */
  private readonly sbLegacy: [ScoreboardRow, ScoreboardRow] = [
    { name: 'Player', team: 0, you: true },
    { name: 'Bot', team: 1, you: false },
  ];
  private readonly sbFoot: HTMLElement;

  // The Turnstile slot, the network panel.
  private readonly turnstileBox: HTMLElement;
  private readonly net: HTMLElement;
  private readonly netBody: HTMLElement;
  private readonly netWait: HTMLElement;
  private lastNetWait: string | null = null;
  private netToggle = false;
  private netAuto = false;
  private netShown = false;
  private lastNetAt = -1e9;
  private lastNetText = '';
  private debug = false;

  private lastBlue = -1;
  private lastRed = -1;
  private lastClockSec = -1;
  private lastClockMode: ClockMode | null = null;
  private lastBoost = -1;
  private lastSpeed = -1;
  private lastSupersonic = false;
  private lastFps = -1;
  private lastInfo = '';
  private lastBallCam: boolean | null = null;
  private lastCountdown: string | null = null;
  private bannerTimer = 0;
  private indVisible = false;
  private indX = -1;
  private indY = -1;
  private indAngle = -1;
  private indDist = -1;
  private rootW = 0;
  private rootH = 0;
  private sbVisible = false;
  private lastSbBlue = -1;
  private lastSbRed = -1;
  private lastSbClock = '';
  private lastSbDifficulty = '';
  private lastSbMode: string | undefined = '';
  private lastHint: string | null = null;

  /** F3 the debug readouts, F4 the network panel (anywhere but a text field). */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.code !== 'F3' && e.code !== 'F4') return;
    if (e.code === 'F3') this.setDebug(!this.debug);
    else this.setNetToggle(!this.netToggle);
    e.preventDefault();
  };

  private readonly onResize = (): void => {
    this.rootW = 0;
    this.rootH = 0;
    this.indRectsKey = '';
  };

  constructor(container: HTMLElement) {
    this.root = el('div', 'hud-root');
    container.appendChild(this.root);

    // Turnstile widget slot: the online client renders the anti-bot widget here while it registers a
    // guest or an account (appearance 'interaction-only': nothing shows unless Cloudflare asks for a
    // click). It sits on the root, above every menu layer (the src/ui front-end and the settings screen).
    this.turnstileBox = el('div', 'hud-turnstile');
    this.turnstileBox.hidden = true;
    this.root.appendChild(this.turnstileBox);

    // Scorebug (top left), as the owner kept it: [BLU 0 │ 3:00 │ 0 RED], the network bars by the
    // clock online, a lime notch under the player's team (setTeam). The three-letter tags keep the
    // teams apart without relying on colour alone. It sits over the pause's veil (--z-score).
    const top = el('div', 'hud-top');
    const board = el('div', 'hud-score');
    this.scoreBlue = el('span', 'hud-score-goals', '0');
    this.scoreRed = el('span', 'hud-score-goals', '0');
    this.clock = el('span', 'hud-clock-time', formatClockSeconds(DEFAULT_MATCH_SECONDS));
    this.netBarsEl = el('span', 'hud-bars');
    this.netBarsEl.append(el('i', ''), el('i', ''), el('i', ''));
    this.netBarsEl.hidden = true;
    const clockBox = el('span', 'hud-clock');
    clockBox.append(this.clock, this.netBarsEl);
    board.append(el('span', 'hud-score-tag hud-blue', t('hud.tagBlue')), this.scoreBlue, clockBox, this.scoreRed, el('span', 'hud-score-tag hud-red', t('hud.tagRed')));
    this.scoreBox = board;
    top.append(board, el('span', 'hud-notch'));
    this.root.appendChild(top);

    const fpsBox = el('div', 'hud-fps');
    this.fps = el('span', 'hud-fps-value', '');
    this.fpsInfo = el('span', 'hud-fps-info', '');
    fpsBox.append(this.fps, this.fpsInfo);
    this.root.appendChild(fpsBox);

    this.camMode = el('div', 'hud-cam', this.labelBallCam);
    this.root.appendChild(this.camMode);

    this.hint = el('div', 'hud-hint');
    this.hint.hidden = true;
    this.root.appendChild(this.hint);

    // Controls card (bottom right): opaque graphite, no blur over the live canvas; the rows come
    // from the Game (setControlsCard), the strip layout is a class on the same element.
    this.controls = el('section', 'hud-controls');
    this.controls.setAttribute('aria-label', t('controls.title'));
    const controlsHead = el('div', 'hud-controls-head');
    this.controlsTag = el('span', 'hud-controls-tag', '');
    controlsHead.append(el('span', 'hud-controls-title', t('controls.title')), this.controlsTag);
    this.controlsRows = el('div', 'hud-controls-rows');
    this.controlsFoot = el('div', 'hud-controls-foot', '');
    this.controls.append(controlsHead, this.controlsRows, this.controlsFoot);
    this.controls.hidden = true;
    this.root.appendChild(this.controls);

    this.speedBox = el('div', 'hud-speed');
    this.speedValue = el('div', 'hud-speed-value', '0');
    const speedUnit = el('div', 'hud-speed-unit', 'km/h');
    this.speedBox.append(this.speedValue, speedUnit);
    this.root.appendChild(this.speedBox);

    // Boost (bottom left): a slanted bar of ten segments with the amount beside it. The fill is
    // one element scaled along x; the segment gaps are a static overlay.
    this.boostBox = el('div', 'hud-boost');
    const boostBar = el('div', 'hud-boost-bar');
    this.boostFill = el('div', 'hud-boost-fill');
    boostBar.append(this.boostFill, el('div', 'hud-boost-segs'));
    this.boostValue = el('div', 'hud-boost-value', '33');
    this.boostBox.append(el('div', 'hud-boost-label', t('hud.boost')), boostBar, this.boostValue);
    this.root.appendChild(this.boostBox);

    // Off-screen ball indicator: a ball glyph pinned to the screen edge with an arrow and distance.
    this.ballInd = el('div', 'hud-ball-ind');
    this.ballIndArrow = el('span', 'hud-ball-ind-arrow');
    const dot = el('span', 'hud-ball-ind-dot');
    this.ballIndDist = el('span', 'hud-ball-ind-dist', '');
    this.ballInd.append(this.ballIndArrow, dot, this.ballIndDist);
    this.ballInd.hidden = true;
    this.root.appendChild(this.ballInd);

    this.countdown = el('div', 'hud-countdown');
    this.countdown.hidden = true;
    this.root.appendChild(this.countdown);
    this.countdownCaption = el('div', 'hud-countdown-caption');
    this.countdownCaption.append(el('b', '', t('game.overtime')), el('span', '', t('game.nextGoalWins')));
    this.countdownCaption.hidden = true;
    this.root.appendChild(this.countdownCaption);

    this.banner = el('div', 'hud-banner');
    this.bannerTitle = el('div', 'hud-banner-title');
    this.bannerSub = el('div', 'hud-banner-sub');
    this.banner.append(this.bannerTitle, this.bannerSub);
    this.banner.hidden = true;
    this.root.appendChild(this.banner);

    // ¡GOOOL! (the owner's banner): the word on a slab of the scoring team's colour with a lime
    // heel, the scorer and the score on a chip under it (showGoal).
    this.goal = el('div', 'hud-goal');
    this.goal.setAttribute('role', 'status');
    const slab = el('div', 'hud-goal-slab');
    slab.append(el('span', 'hud-goal-word', t('hud.goal')));
    this.goalChip = el('div', 'hud-goal-chip');
    this.goal.append(slab, this.goalChip);
    this.goal.hidden = true;
    this.root.appendChild(this.goal);

    // The feed (top centre): who joined or left, a bot taking over, your demolitions.
    this.feedEl = el('div', 'hud-feed');
    this.feedEl.setAttribute('role', 'status');
    this.root.appendChild(this.feedEl);

    // Scoreboard (held Tab / Back): team scores, clock, who is who.
    this.scoreboard = el('div', 'hud-scoreboard');
    const sbPanel = el('div', 'hud-sb-panel');
    const sbHead = el('div', 'hud-sb-head');
    this.sbBlue = el('div', 'hud-sb-score hud-blue', '0');
    this.sbClock = el('div', 'hud-sb-clock', '5:00');
    this.sbRed = el('div', 'hud-sb-score hud-red', '0');
    sbHead.append(this.sbBlue, this.sbClock, this.sbRed);
    const sbTeams = el('div', 'hud-sb-teams');
    const blueCol = el('div', 'hud-sb-team hud-blue');
    const blueRows = el('div', 'hud-sb-rows');
    blueCol.append(el('div', 'hud-sb-team-name', t('hud.teamBlue')), blueRows);
    const redCol = el('div', 'hud-sb-team hud-red');
    const redRows = el('div', 'hud-sb-rows');
    redCol.append(el('div', 'hud-sb-team-name', t('hud.teamRed')), redRows);
    this.sbRowsEl = [blueRows, redRows];
    sbTeams.append(blueCol, redCol);
    this.sbFoot = el('div', 'hud-sb-foot', '');
    sbPanel.append(sbHead, sbTeams, this.sbFoot);
    this.scoreboard.appendChild(sbPanel);
    this.scoreboard.hidden = true;
    this.root.appendChild(this.scoreboard);

    // The pause (plan §1.4 "Pausa"): the veil without blur, the scorebug above it (--z-score), a
    // title plate (PAUSA; online "● PARTIDO EN JUEGO": the match goes on, the car stands still) and
    // the dock at the bottom, for every input: the mouse and a finger click its buttons, the
    // keyboard and the pad move the focus over it (FocusNav; the Game routes Input's menu edges to
    // pauseAction). Only the plate and the dock take the pointer: a click on the veil still reaches
    // the canvas (resume; a finger's tap there does nothing, Game.onCanvasPointerDown). The key line
    // stays for the keyboard (style.css hides it in touch mode, and lays the dock out for two
    // thumbs). QUIT is held (PauseEntry.hold): a slip next to RESUME leaves no match.
    this.paused = el('div', 'hud-paused');
    this.pausedTitle = el('div', 'hud-paused-title', t('pause.title'));
    this.pausedLive = el('div', 'hud-paused-live');
    this.pausedLive.append(el('b', '', t('pause.live')), el('span', '', t('pause.liveSub')));
    this.pausedLive.hidden = true;
    this.pausedSub = el('div', 'hud-paused-sub', t('pause.hintDefault', { resumeKeys: pauseResumeKeys('Esc', 'Start') }));
    const plate = el('div', 'hud-paused-plate');
    plate.append(this.pausedTitle, this.pausedLive, this.pausedSub);
    this.pauseMenu = el('div', 'hud-pause-menu');
    // DOM focus stays off a clicked button (a mouse has no ring), and Enter / Space never click the
    // focused one natively: the Game's accept does (pauseAction), once.
    this.pauseMenu.addEventListener('mousedown', (e: MouseEvent) => e.preventDefault());
    const noNative = (e: KeyboardEvent): void => {
      if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') e.preventDefault();
    };
    this.pauseMenu.addEventListener('keydown', noNative);
    this.pauseMenu.addEventListener('keyup', noNative);
    this.pauseNav = new FocusNav(() => [{ name: 'dock', el: this.pauseMenu, main: true }], {
      onFocus: (target) => {
        for (const b of this.pauseMenu.querySelectorAll('.hud-focus')) b.classList.remove('hud-focus');
        target.classList.add('hud-focus');
        target.parentElement?.classList.toggle('hud-focus', target.parentElement.classList.contains('hud-pause-row'));
      },
    });
    this.pauseNav.install(this.pauseMenu);
    this.paused.append(plate, this.pauseMenu);
    this.paused.hidden = true;
    this.root.appendChild(this.paused);

    // Network panel (online): F4 toggles it, `#net` shows it from the start, debug mode shows it
    // while a match is online (setNetAuto).
    this.net = el('div', 'hud-net');
    this.netBody = el('pre', 'hud-net-body', '');
    this.net.append(el('div', 'hud-net-title', 'NETWORK  (F4)'), this.netBody);
    this.net.hidden = true;
    this.root.appendChild(this.net);
    // In-match wait line (P2P stall: 'Esperando a <name>…').
    this.netWait = el('div', 'hud-netwait');
    this.netWait.hidden = true;
    this.root.appendChild(this.netWait);

    // Whole words of the hash (hashFlags.ts): `#hide=stadium-netting` is not `#net`.
    const flags = pageFlags();
    this.setDebug(flags.stats || flags.debug);
    this.setNetToggle(flags.net);

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('resize', this.onResize);
  }

  /** Show / hide the debug readouts (speed, fps, draw calls, GPU time). F3 toggles this. */
  setDebug(on: boolean): void {
    this.debug = on;
    this.root.classList.toggle('hud-debug', on);
  }

  get debugVisible(): boolean {
    return this.debug;
  }

  // ---- network panel -----------------------------------------------------------------------

  /** Manual switch of the network panel (F4 / #net). */
  setNetToggle(on: boolean): void {
    this.netToggle = on;
    this.refreshNet();
  }

  /** Online match in progress: with the debug readouts (F3) on, the panel shows by itself. */
  setNetAuto(on: boolean): void {
    if (on === this.netAuto) return;
    this.netAuto = on;
    this.refreshNet();
  }

  get netVisible(): boolean {
    return this.netShown;
  }

  private refreshNet(): void {
    const show = this.netToggle || (this.netAuto && this.debug);
    if (show === this.netShown) return;
    this.netShown = show;
    this.net.hidden = !show;
    if (!show) this.lastNetText = '';
  }

  /** Fill the network panel (at most 4x/s; the text is rebuilt only when it changed). */
  setNetStats(s: NetStatsView): void {
    if (!this.netShown) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this.lastNetAt < 250) return;
    this.lastNetAt = now;
    const text = formatNetStats(s);
    if (text === this.lastNetText) return;
    this.lastNetText = text;
    this.netBody.textContent = text;
  }

  /** In-match wait line (a P2P stall: 'Esperando a <name>…'); null hides it. Cached. */
  setNetWait(text: string | null): void {
    if (text === this.lastNetWait) return;
    this.lastNetWait = text;
    if (text === null) {
      this.netWait.hidden = true;
      return;
    }
    this.netWait.textContent = text;
    this.netWait.hidden = false;
  }

  /** The player's team: the lime notch under its side of the scorebug. */
  setTeam(team: 0 | 1): void {
    if (team === this.lastTeam) return;
    this.lastTeam = team;
    this.scoreBox.parentElement?.classList.toggle('hud-mine-red', team === 1);
  }

  /** The network bars by the clock (netBars: 1 to 3); 0 hides them (offline, nothing measured yet). Cached. */
  setNetBars(bars: 0 | 1 | 2 | 3): void {
    if (bars === this.lastBars) return;
    this.lastBars = bars;
    this.netBarsEl.hidden = bars === 0;
    this.netBarsEl.dataset.bars = String(bars);
  }

  /**
   * Slot for the Turnstile widget, above every menu layer (NetClient renders into it and unhides it
   * only while a challenge lives).
   */
  get turnstileContainer(): HTMLElement {
    return this.turnstileBox;
  }

  setScore(blue: number, red: number): void {
    if (blue !== this.lastBlue) {
      this.lastBlue = blue;
      this.scoreBlue.textContent = String(blue);
    }
    if (red !== this.lastRed) {
      this.lastRed = red;
      this.scoreRed.textContent = String(red);
    }
  }

  /**
   * Match clock. `seconds` is what to show (Match.displaySeconds: already an integer that counts
   * down in regulation and up in overtime / unlimited matches). `mode` picks the styling: the
   * low-time amber only in regulation, '+m:ss' blinking red in overtime. A boolean is accepted
   * for the old (seconds, overtime) signature.
   */
  setClock(seconds: number, mode: ClockMode | boolean = 'regulation'): void {
    const m: ClockMode = typeof mode === 'boolean' ? (mode ? 'overtime' : 'regulation') : mode;
    // Regulation callers may still pass fractional countdown seconds: round up like a stopwatch.
    const s = Math.max(0, m === 'regulation' ? Math.ceil(seconds - 1e-6) : Math.floor(seconds + 1e-6));
    if (s === this.lastClockSec && m === this.lastClockMode) return;
    this.lastClockSec = s;
    this.lastClockMode = m;
    const mins = Math.floor(s / 60);
    const r = s % 60;
    const overtime = m === 'overtime';
    this.clock.textContent = `${overtime ? '+' : ''}${mins}:${r < 10 ? '0' : ''}${r}`;
    this.clock.classList.toggle('hud-overtime', overtime);
    this.clock.classList.toggle('hud-clock-low', m === 'regulation' && s <= 10);
  }

  /** Boost 0..100: the bar's fill scale and the number (empty / low / full restyle the bar). */
  setBoost(amount: number): void {
    const b = Math.round(amount < 0 ? 0 : amount > 100 ? 100 : amount);
    if (b === this.lastBoost) return;
    this.lastBoost = b;
    this.boostValue.textContent = String(b);
    this.boostFill.style.transform = `scaleX(${b / 100})`;
    this.boostBox.classList.toggle('hud-boost-empty', b === 0);
    this.boostBox.classList.toggle('hud-boost-low', b > 0 && b < 20);
    this.boostBox.classList.toggle('hud-boost-full', b === 100);
  }

  /** Speed in uu/s, displayed in km/h (1 uu = 1 cm: 2300 uu/s is about 83 km/h). */
  setSpeed(uuPerSec: number, supersonic: boolean): void {
    const kmh = Math.round(uuPerSec * 0.036);
    if (kmh !== this.lastSpeed) {
      this.lastSpeed = kmh;
      this.speedValue.textContent = String(kmh);
    }
    if (supersonic !== this.lastSupersonic) {
      this.lastSupersonic = supersonic;
      this.speedBox.classList.toggle('hud-supersonic', supersonic);
    }
  }

  /** Frames per second plus an info line (backend, draw calls, GPU time...). Only shown in debug mode. */
  setFps(fps: number, info?: string): void {
    const f = Math.round(fps);
    if (f !== this.lastFps) {
      this.lastFps = f;
      this.fps.textContent = `${f} fps`;
    }
    const i = info ?? '';
    if (i !== this.lastInfo) {
      this.lastInfo = i;
      this.fpsInfo.textContent = i;
    }
  }

  setCameraMode(ballCam: boolean): void {
    if (ballCam === this.lastBallCam) return;
    this.lastBallCam = ballCam;
    this.camMode.textContent = ballCam ? this.labelBallCam : this.labelCarCam;
    this.camMode.classList.toggle('hud-cam-off', !ballCam);
  }

  /**
   * Off-screen ball indicator. `nx`/`ny` is the screen position in NDC (-1..1, y up) where the
   * glyph is pinned (the caller clamps it to the screen edge), `angleDeg` the arrow direction
   * (0 = right, counter-clockwise like atan2 in NDC), `distanceM` the distance to the ball in
   * metres. Rounded values are cached so the DOM is written only when something moved.
   */
  setBallIndicator(visible: boolean, nx = 0, ny = 0, angleDeg = 0, distanceM = 0): void {
    if (visible !== this.indVisible) {
      this.indVisible = visible;
      this.ballInd.hidden = !visible;
    }
    if (!visible) return;
    if (this.rootW === 0) {
      this.rootW = this.root.clientWidth;
      this.rootH = this.root.clientHeight;
    }
    this.measurePlates();
    const at = this.indAt;
    avoidRects((nx + 1) * 0.5 * this.rootW, (1 - ny) * 0.5 * this.rootH, IND_REACH, this.indRects, this.rootW, this.rootH, at);
    const x = Math.round(at.x / 2) * 2;
    const y = Math.round(at.y / 2) * 2;
    const a = Math.round(angleDeg / 2) * 2;
    if (x !== this.indX || y !== this.indY) {
      this.indX = x;
      this.indY = y;
      this.ballInd.style.transform = `translate(${x}px, ${y}px)`;
    }
    if (a !== this.indAngle) {
      this.indAngle = a;
      // CSS rotates clockwise; NDC angles are counter-clockwise.
      this.ballIndArrow.style.transform = `rotate(${-a}deg) translateX(22px)`;
    }
    const d = Math.round(distanceM);
    if (d !== this.indDist) {
      this.indDist = d;
      this.ballIndDist.textContent = `${d} m`;
    }
  }

  /** The scorebug's, the boost plate's and the controls card's boxes: again after a resize or as the card comes or goes (a few times a match). */
  private measurePlates(): void {
    const key = this.controls.hidden ? 'off' : this.controlsView;
    if (key === this.indRectsKey && this.indRects.length > 0) return;
    this.indRectsKey = key;
    const o = this.root.getBoundingClientRect();
    this.indRects.length = 0;
    for (const e of [this.scoreBox, this.boostBox, this.controls]) {
      if (e.hidden) continue;
      const r = e.getBoundingClientRect();
      if (r.width > 0) this.indRects.push({ left: r.left - o.left, top: r.top - o.top, right: r.right - o.left, bottom: r.bottom - o.top });
    }
  }

  /** Kickoff countdown: 3, 2, 1, 'GO' (a token: shown as hud.go); null hides it. GO and null end the overtime line. */
  showCountdown(n: number | 'GO' | null): void {
    if (n === null || n === 'GO') this.countdownCaption.hidden = true;
    const text = n === null ? null : n === 'GO' ? this.labelGo : String(n);
    if (text === this.lastCountdown) return;
    this.lastCountdown = text;
    if (text === null) {
      this.countdown.hidden = true;
      return;
    }
    this.countdown.textContent = text;
    this.countdown.hidden = false;
    this.countdown.classList.toggle('hud-countdown-go', n === 'GO');
    // Restart the pop animation.
    this.countdown.classList.remove('hud-pop');
    void this.countdown.offsetWidth;
    this.countdown.classList.add('hud-pop');
  }

  /** Overtime: "TIEMPO EXTRA · next goal wins" over the overtime kickoff's countdown, until its GO (the centre stays the goal's and the whistle's). */
  showOvertime(): void {
    this.countdownCaption.hidden = false;
  }

  /** Centre banner (the final whistle; a goal is showGoal's), hidden after `ms` (0 = until the next banner). */
  showBanner(title: string, sub = '', ms = 2500, team: 0 | 1 | null = null): void {
    this.hideGoal();
    this.bannerTitle.textContent = title;
    this.bannerSub.textContent = sub;
    this.bannerSub.hidden = sub.length === 0;
    this.banner.classList.toggle('hud-blue', team === 0);
    this.banner.classList.toggle('hud-red', team === 1);
    this.banner.hidden = false;
    this.banner.classList.remove('hud-pop');
    void this.banner.offsetWidth;
    this.banner.classList.add('hud-pop');
    if (this.bannerTimer !== 0) window.clearTimeout(this.bannerTimer);
    this.bannerTimer = 0;
    if (ms > 0) {
      this.bannerTimer = window.setTimeout(() => {
        this.banner.hidden = true;
        this.bannerTimer = 0;
      }, ms);
    }
  }

  hideBanner(): void {
    if (this.bannerTimer !== 0) window.clearTimeout(this.bannerTimer);
    this.bannerTimer = 0;
    this.banner.hidden = true;
    this.hideGoal();
  }

  /**
   * ¡GOOOL! for `team`: its slab, and the chip "● scorer │ Azul 1 – 0 Rojo" (the scorer left out
   * when nobody of that team touched the ball in the play: finalModel.ts goalScorer), for `ms`.
   */
  showGoal(team: 0 | 1, scorer: string | null, blue: number, red: number, ms = 2500): void {
    if (this.bannerTimer !== 0) window.clearTimeout(this.bannerTimer);
    this.bannerTimer = 0;
    this.banner.hidden = true;
    this.goal.classList.toggle('hud-blue', team === 0);
    this.goal.classList.toggle('hud-red', team === 1);
    const score = el('span', 'hud-goal-score', t('hud.goalScore', { blue, red, blueName: t('hud.teamBlue'), redName: t('hud.teamRed') }));
    if (scorer !== null) this.goalChip.replaceChildren(el('i', 'hud-goal-dot'), el('b', 'hud-goal-name', scorer), el('i', 'hud-goal-sep'), score);
    else this.goalChip.replaceChildren(score);
    this.goal.setAttribute('aria-label', scorer !== null ? t('hud.goalBy', { name: scorer, blue, red }) : t('hud.goalLabel', { blue, red }));
    this.goal.hidden = false;
    this.goal.classList.remove('hud-pop');
    void this.goal.offsetWidth;
    this.goal.classList.add('hud-pop');
    if (this.goalTimer !== 0) window.clearTimeout(this.goalTimer);
    this.goalTimer = window.setTimeout(() => this.hideGoal(), ms);
  }

  private hideGoal(): void {
    if (this.goalTimer !== 0) window.clearTimeout(this.goalTimer);
    this.goalTimer = 0;
    this.goal.hidden = true;
  }

  /** A chip on the feed (top centre) for FEED_MS; the oldest goes when a third comes. `kind` picks its mark. */
  feed(text: string, kind: 'join' | 'leave' | 'bot' | 'demo' = 'join'): void {
    const chip = el('div', `hud-feed-chip hud-feed-${kind}`, text);
    this.feedEl.appendChild(chip);
    while (this.feedEl.childElementCount > FEED_MAX) this.feedEl.firstElementChild?.remove();
    window.setTimeout(() => chip.remove(), FEED_MS);
  }

  /** The feed and the overtime line emptied (a match leaves the screen). */
  clearFeed(): void {
    this.feedEl.replaceChildren();
    this.countdownCaption.hidden = true;
  }

  /**
   * Show the pause dock with `entries` (the focus on the first; on none for a finger) and `hint` as
   * its key line, or hide it. `live`: an online match, which goes on meanwhile ("● PARTIDO EN
   * JUEGO"). Called on pause only (it rebuilds the buttons), never per frame.
   */
  setPaused(paused: boolean, entries: readonly PauseEntry[] = [], hint?: string, live = false): void {
    this.pauseOpen = paused;
    this.pauseCovered = false;
    this.endHold(false);
    this.paused.hidden = !paused;
    this.root.classList.toggle('hud-pausing', paused);
    if (!paused) {
      this.pauseMenu.textContent = '';
      this.pauseButtons.length = 0;
      return;
    }
    this.pausedTitle.hidden = live;
    this.pausedLive.hidden = !live;
    if (hint !== undefined) this.pausedSub.textContent = hint;
    this.buildPauseMenu(entries);
  }

  /** The pause menu is up (and not covered by the settings screen). */
  get pauseMenuVisible(): boolean {
    return this.pauseOpen && !this.pauseCovered;
  }

  /**
   * The settings screen opens over the pause menu (`covered`: the menu hides, the game stays
   * paused) or closes again: the menu comes back with the focus on entry `focusId`.
   */
  setPauseCovered(covered: boolean, focusId?: string): void {
    if (!this.pauseOpen) return;
    this.pauseCovered = covered;
    this.paused.hidden = covered;
    this.endHold(false);
    if (!covered && focusId !== undefined) {
      const i = this.pauseEntries.findIndex((e) => e.id === focusId);
      if (i >= 0 && !touchMode()) this.pauseNav.focus(this.pauseButtons[i]);
    }
  }

  /** The pause menu's key line (the pause binding may have changed in the settings screen). */
  setPauseHint(hint: string): void {
    if (this.pausedSub.textContent !== hint) this.pausedSub.textContent = hint;
  }

  /** Keyboard / pad on the pause dock (Input's menu edges, routed by the Game while paused). */
  pauseAction(action: PauseAction): void {
    if (!this.pauseMenuVisible) return;
    if (action !== 'accept') {
      this.endHold(false);
      this.pauseNav.move(action);
      return;
    }
    const cur = this.pauseNav.current;
    if (cur === null) {
      this.pauseNav.first();
      return;
    }
    const entry = this.pauseEntries[this.pauseButtons.indexOf(cur as HTMLButtonElement)];
    if (entry === undefined) return;
    if (entry.hold === true) this.startHold(entry, true);
    else this.activatePause(entry, false);
  }

  /** A hold started by A / Enter: still waiting for them to be let go (the Game asks Input.acceptHeld). */
  get pauseHoldByKey(): boolean {
    return this.holding !== null && this.holdByKey;
  }

  /** A / Enter let go before the hold filled: it empties again. */
  pauseHoldRelease(): void {
    if (this.holdByKey) this.endHold(false);
  }

  private buildPauseMenu(entries: readonly PauseEntry[]): void {
    const menu = this.pauseMenu;
    menu.textContent = '';
    this.pauseEntries = entries;
    const buttons = this.pauseButtons;
    buttons.length = 0;
    // A run of 'row' entries shares one line (left / right walk it: data-nav-row).
    let row: HTMLElement | null = null;
    for (const entry of entries) {
      const kind = entry.kind ?? 'plain';
      const b = button(`hud-pause-btn hud-pause-${kind}${entry.hold === true ? ' hud-pause-hold' : ''}`, '');
      b.setAttribute('data-nav', '');
      this.fillPauseButton(b, entry);
      b.addEventListener('click', (e: MouseEvent) => {
        // A press of a held entry says how (its line lights up); the hold or a double click leaves.
        if (entry.hold === true) this.armHold(b);
        else this.activatePause(entry, isMouseClick(e));
      });
      if (entry.hold === true) {
        b.addEventListener('dblclick', (e: MouseEvent) => {
          if (isMouseClick(e)) this.activatePause(entry, true);
        });
        b.addEventListener('pointerdown', (e: PointerEvent) => {
          if (e.pointerType !== 'mouse') this.startHold(entry, false);
        });
        const up = (e: PointerEvent): void => {
          if (e.pointerType !== 'mouse' && !this.holdByKey) this.endHold(false);
        };
        b.addEventListener('pointerup', up);
        b.addEventListener('pointercancel', up);
        b.addEventListener('pointerleave', up);
      }
      if (kind === 'row') {
        if (row === null) {
          row = el('div', 'hud-pause-row');
          row.setAttribute('data-nav-row', '');
          menu.appendChild(row);
        }
        row.appendChild(b);
      } else {
        row = null;
        menu.appendChild(b);
      }
      buttons.push(b);
    }
    // The focus starts on the first entry (RESUME), as before; a finger's pause focuses nothing (no ring).
    if (buttons.length > 0 && !touchMode()) this.pauseNav.focus(buttons[0]);
  }

  /** A button's label and its line (read again after every activation: a toggle changes its label). */
  private fillPauseButton(b: HTMLButtonElement, entry: PauseEntry): void {
    const sub = entry.sub?.() ?? null;
    const parts: HTMLElement[] = [];
    if (entry.hold === true) parts.push(el('span', 'hud-hold-fill'));
    parts.push(el('span', 'hud-pause-label', entry.label()));
    if (sub !== null) parts.push(el('span', 'hud-pause-sub', sub));
    if (entry.hold === true) parts.push(el('span', 'hud-pause-howto hud-howto-hold', t('pause.holdHint')), el('span', 'hud-pause-howto hud-howto-dbl', t('pause.dblHint')));
    b.replaceChildren(...parts);
  }

  private activatePause(entry: PauseEntry, mouse: boolean): void {
    if (!this.pauseMenuVisible || !this.pauseEntries.includes(entry)) return;
    this.endHold(false);
    const entries = this.pauseEntries;
    entry.select(mouse);
    // Still the same menu (a toggle, not resume / quit): its labels may have changed.
    if (this.pauseOpen && this.pauseEntries === entries) {
      for (let k = 0; k < entries.length; k++) this.fillPauseButton(this.pauseButtons[k], entries[k]);
    }
  }

  /** Start filling `entry`'s button: HOLD_MS later it is picked, unless let go first. */
  private startHold(entry: PauseEntry, byKey: boolean): void {
    if (!this.pauseMenuVisible || this.holding === entry) return;
    this.endHold(false);
    const b = this.pauseButtons[this.pauseEntries.indexOf(entry)];
    if (b === undefined) return;
    this.holding = entry;
    this.holdByKey = byKey;
    b.classList.add('hud-holding');
    this.holdTimer = window.setTimeout(() => this.endHold(true), HOLD_MS);
  }

  /** The hold ends: `done` picks the entry, else its button empties again. */
  private endHold(done: boolean): void {
    const entry = this.holding;
    if (entry === null) return;
    this.holding = null;
    this.holdByKey = false;
    window.clearTimeout(this.holdTimer);
    this.holdTimer = 0;
    const b = this.pauseButtons[this.pauseEntries.indexOf(entry)];
    if (b !== undefined) b.classList.remove('hud-holding');
    if (done) this.activatePause(entry, false);
  }

  /** A plain press of a held entry: its how-to line lights up a moment. */
  private armHold(b: HTMLButtonElement): void {
    b.classList.remove('hud-pause-armed');
    void b.offsetWidth;
    b.classList.add('hud-pause-armed');
  }

  /**
   * The Tab scoreboard: translucent centred table with both scores, the clock and who plays on
   * each team. Safe to call every frame with the same `data` object: every field is cached.
   */
  showScoreboard(visible: boolean, data: ScoreboardData): void {
    if (visible !== this.sbVisible) {
      this.sbVisible = visible;
      this.scoreboard.hidden = !visible;
    }
    if (!visible) return;
    if (data.blue !== this.lastSbBlue) {
      this.lastSbBlue = data.blue;
      this.sbBlue.textContent = String(data.blue);
    }
    if (data.red !== this.lastSbRed) {
      this.lastSbRed = data.red;
      this.sbRed.textContent = String(data.red);
    }
    if (data.clock !== this.lastSbClock) {
      this.lastSbClock = data.clock;
      this.sbClock.textContent = data.clock;
    }
    let rows = data.rows;
    if (rows === undefined) {
      const youBlue = (data.playerTeam ?? 0) === 0;
      const legacy = this.sbLegacy;
      legacy[0].name = data.playerName ?? 'Player';
      legacy[0].team = youBlue ? 0 : 1;
      legacy[1].name = data.botName ?? 'Bot';
      legacy[1].team = youBlue ? 1 : 0;
      rows = legacy;
    }
    if (this.sbRowsChanged(rows)) this.renderScoreboardRows(rows);
    if (data.difficulty !== this.lastSbDifficulty || data.mode !== this.lastSbMode) {
      this.lastSbDifficulty = data.difficulty;
      this.lastSbMode = data.mode;
      const difficulty = t('hud.botDifficulty', { difficulty: data.difficulty });
      this.sbFoot.textContent = data.mode !== undefined ? `${data.mode}  ·  ${difficulty}` : difficulty;
    }
  }

  /** Content diff against the rows in the DOM (no allocations; at most MAX_CARS rows). */
  private sbRowsChanged(rows: readonly ScoreboardRow[]): boolean {
    const shown = this.sbShown;
    if (shown.length !== rows.length) return true;
    for (let i = 0; i < rows.length; i++) {
      const a = shown[i];
      const b = rows[i];
      if (a.name !== b.name || a.team !== b.team || a.you !== b.you || a.bot !== (b.bot !== false)) return true;
    }
    return false;
  }

  /** Rebuild both team columns (only when a roster / name changed: a few times per session). */
  private renderScoreboardRows(rows: readonly ScoreboardRow[]): void {
    const shown = this.sbShown;
    shown.length = 0;
    const cols = this.sbRowsEl;
    cols[0].textContent = '';
    cols[1].textContent = '';
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const bot = r.bot !== false;
      const row = el('div', r.you ? 'hud-sb-row hud-sb-you' : 'hud-sb-row');
      row.append(el('span', r.you ? 'hud-sb-tag hud-you' : 'hud-sb-tag', r.you ? this.labelYou : bot ? this.labelBot : ''), el('span', 'hud-sb-name', r.name));
      cols[r.team === 1 ? 1 : 0].appendChild(row);
      shown.push({ name: r.name, team: r.team, you: r.you, bot });
    }
  }

  /** Small bottom-centre hint (e.g. 'Click to capture the mouse'); null hides it. Cached. */
  showHint(text: string | null): void {
    if (text === this.lastHint) return;
    this.lastHint = text;
    if (text === null) {
      this.hint.hidden = true;
      return;
    }
    this.hint.textContent = text;
    this.hint.hidden = false;
  }

  /**
   * The controls card: 'full' the big card, 'strip' the slim corner strip, 'off' hidden (also
   * without content). A new `content` object rebuilds the rows (the Game makes one only when the
   * device, a binding or the tag changes), so a per-frame call with the same arguments costs nothing.
   */
  setControlsCard(view: CardView, content: ControlsCardContent | null): void {
    if (content !== null && content !== this.controlsContent) {
      this.controlsContent = content;
      this.controlsTag.textContent = content.tag;
      this.controlsFoot.textContent = content.foot;
      const rows: HTMLElement[] = [];
      for (const r of content.rows) {
        const keys = el('span', 'hud-controls-keys');
        for (const k of r.keys) keys.appendChild(k.kind === 'mouse' ? mouseKey(k) : el('kbd', k.kind === 'pad' ? 'hud-key hud-key-pad' : 'hud-key', k.label));
        const row = el('div', 'hud-controls-row');
        row.append(el('span', 'hud-controls-label', r.label), keys);
        rows.push(row);
      }
      this.controlsRows.replaceChildren(...rows);
    }
    const shown = view !== 'off' && this.controlsContent !== null;
    if (view === this.controlsView && shown === !this.controls.hidden) return;
    this.controlsView = view;
    this.controls.hidden = !shown;
    this.controls.classList.toggle('hud-controls-strip', view === 'strip');
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('resize', this.onResize);
    if (this.bannerTimer !== 0) window.clearTimeout(this.bannerTimer);
    this.hideGoal();
    this.endHold(false);
    this.root.remove();
  }
}

/**
 * Network panel text (NetStatsView -> a few fixed-width lines; called at most 4x/s). A match on a
 * community node gets a `host` line with the node's name, so testers can tell which node they got.
 */
export function formatNetStats(s: NetStatsView): string {
  if (s.kind === 'p2p') return formatP2pStats(s);
  const age = s.snapshotAgeMs < 0 ? '—' : `${Math.round(s.snapshotAgeMs)} ms`;
  return (
    `state     ${s.state}\n` +
    (isNodeHost(s.host) ? `host      ${s.host}\n` : '') +
    `ping      ${s.rttMs.toFixed(1)} ms  jitter ${s.jitterMs.toFixed(1)} ms  loss ${s.lossPct.toFixed(1)} %\n` +
    `lead      ${s.lead} ticks (adj ${s.leadAdjust >= 0 ? '+' : ''}${s.leadAdjust})  rate ${s.rateScale.toFixed(3)}x\n` +
    `tick      host ${s.hostTick}  local ${s.localTick}\n` +
    `rollback  ${s.rollbacksPerSec.toFixed(1)} /s  replayed ${s.replayedPerSec.toFixed(0)} ticks/s\n` +
    `desyncs   ${s.desyncs}  resyncs ${s.resyncs}  mispred ${s.mispredictions}  err ${s.errorCar.toFixed(0)} uu\n` +
    `buffer    hint ${s.bufferHint >= 0 ? '+' : ''}${s.bufferHint}\n` +
    `bytes     in ${formatBytesPerSec(s.bytesInPerSec)}  out ${formatBytesPerSec(s.bytesOutPerSec)}\n` +
    `snapshot  age ${age}  reconnects ${s.reconnects}`
  );
}

/** The P2P panel: engine lines plus one row per peer (slot / name, link state, RTT, candidate type, newest tick). */
export function formatP2pStats(s: NetStatsView): string {
  let text =
    `state     ${s.state}  (P2P, delay ${s.inputDelay} ticks)\n` +
    `tick      confirmed ${s.confirmedTick}  predicted +${s.predictedAhead}  ahead ${s.bufferHint}\n` +
    `rollback  ${s.rollbacksPerSec.toFixed(1)} /s  resim ${s.replayedPerSec.toFixed(0)} ticks/s\n` +
    `stalls    ${s.stalls}  timesync ${s.timesyncSkips}  desyncs ${s.desyncs}  resyncs ${s.resyncs}\n` +
    `bytes     in ${formatBytesPerSec(s.bytesInPerSec)}  out ${formatBytesPerSec(s.bytesOutPerSec)}\n` +
    `peers     ${s.p2pPeers}`;
  for (let i = 0; i < s.p2pPeers; i++) {
    const cand = PEER_CAND_LABELS[s.p2pPeerCand[i]] ?? '?';
    const state = PEER_STATE_LABELS[s.p2pPeerState[i]] ?? '?';
    text += `\n  #${s.p2pPeerSlot[i]} ${s.p2pPeerName[i].padEnd(12).slice(0, 12)} ${state.padEnd(10)} ${s.p2pPeerRtt[i].toFixed(0).padStart(4)} ms  ${cand.padEnd(5)} tick ${s.p2pPeerTick[i]}`;
  }
  return text;
}

function formatBytesPerSec(b: number): string {
  return b >= 10_000 ? `${(b / 1000).toFixed(1)} kB/s` : `${Math.round(b)} B/s`;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** The lit part of the controls card's mouse (24 × 24 view box): left half, wheel, right half. */
const MOUSE_LIT: Readonly<Record<number, string>> = {
  0: 'M11.1 4.1A5.1 5.1 0 0 0 6.9 9.2V9.4H11.1Z',
  1: 'M11 5h2v4h-2Z',
  2: 'M12.9 4.1A5.1 5.1 0 0 1 17.1 9.2V9.4H12.9Z',
};

/** A mouse button on the controls card: a small mouse with that button lit, then its name ('Right click'). */
function mouseKey(k: CardKey): HTMLElement {
  const box = el('span', 'hud-controls-mouse');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'hud-mouse');
  const outline = document.createElementNS(SVG_NS, 'path');
  outline.setAttribute('d', 'M12 3a6 6 0 0 1 6 6v6a6 6 0 0 1-12 0V9a6 6 0 0 1 6-6ZM6 10h12M12 3v7');
  svg.appendChild(outline);
  const lit = k.button !== undefined ? MOUSE_LIT[k.button] : undefined;
  if (lit !== undefined) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', lit);
    p.setAttribute('class', 'hud-mouse-lit');
    svg.appendChild(p);
  }
  box.append(svg, el('span', 'hud-controls-mouse-name', k.label));
  return box;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(className: string, text: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = text;
  b.tabIndex = -1;
  return b;
}
