/**
 * Training HUD (free play and shot packs, src/game/TrainingSession.ts): a DOM overlay next to the
 * match Hud, styled by ./training.css (classes prefixed `trn-`).
 *
 *   top left      pack name, "Shot n / N · <shot name>", attempts, one dot per shot (pass / fail /
 *                 none, the current one ringed) and the shot timer bar; free play shows its
 *                 unlimited-boost state instead; under it the training key hints, from the live
 *                 bindings of the device in use (kept in the panel: the bottom centre belongs to
 *                 the Hud's pointer-lock hint and camera mode)
 *   centre        "drive to start" while a shot waits for the first input, the success / fail
 *                 banner, the pack summary panel (passed / total, best, retry / back to menu)
 *   pause         while the Hud's PAUSED overlay is up: Resume / Reset shot / Previous / Next /
 *                 Quit (free play: Reset ball / Reset car / Unlimited boost) buttons
 *
 * While open it puts `trn-on` on its container so training.css can hide the match score / clock.
 * Like the Hud, every per-frame setter caches what it last wrote and touches the DOM only on a
 * change: calling them every frame allocates nothing. Buttons are real <button>s: Input ignores
 * presses on them (they are UI, not boost / jump) and the canvas never sees the click.
 */
import './training.css';
import type { ShotOutcome, TrainingSummary } from '../game/TrainingSession';

/** What the overlay's buttons do (the Game wires them to the session). */
export interface TrainingHudActions {
  onResume(): void;
  /** Pack: reset the shot. Free play: reset the ball. */
  onReset(): void;
  onPrev(): void;
  onNext(): void;
  /** Free play: car back to its spawn. */
  onResetCar(): void;
  /** Free play: toggle unlimited boost. */
  onToggleBoost(): void;
  onRetryPack(): void;
  /** Leave training for the menu. */
  onQuit(): void;
}

/** Binding labels for the key hints ('—' when unbound). */
export interface TrainingHints {
  reset: string;
  prev: string;
  next: string;
  resetCar: string;
  boost: string;
  pause: string;
  /** The menu accept / back keys for the summary panel (fixed, per device). */
  accept: string;
  back: string;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = text;
  b.tabIndex = -1;
  b.addEventListener('click', (e) => {
    e.preventDefault();
    onClick();
  });
  return b;
}

/** Restart a CSS animation class on an element (forces a reflow between remove and add). */
function pop(e: HTMLElement): void {
  e.classList.remove('trn-pop');
  void e.offsetWidth;
  e.classList.add('trn-pop');
}

export class TrainingHud {
  readonly root: HTMLElement;

  private readonly container: HTMLElement;
  private readonly actions: TrainingHudActions;

  private readonly panel: HTMLElement;
  private readonly title: HTMLElement;
  private readonly shotLine: HTMLElement;
  private readonly attemptsLine: HTMLElement;
  private readonly dots: HTMLElement;
  private readonly timer: HTMLElement;
  private readonly timerFill: HTMLElement;
  private readonly timerText: HTMLElement;
  private readonly boostLine: HTMLElement;
  private readonly start: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly bannerTitle: HTMLElement;
  private readonly bannerSub: HTMLElement;
  private readonly keys: HTMLElement;
  private readonly pausePanel: HTMLElement;
  private readonly packButtons: HTMLElement[] = [];
  private readonly freeButtons: HTMLElement[] = [];
  private readonly boostButton: HTMLButtonElement;
  private readonly summary: HTMLElement;
  private readonly sumPack: HTMLElement;
  private readonly sumScore: HTMLElement;
  private readonly sumBest: HTMLElement;
  private readonly sumDots: HTMLElement;
  private readonly sumHint: HTMLElement;

  private open = false;
  private freeplay = false;
  /** Dot elements of the current pack (rebuilt by show()). */
  private readonly dotEls: HTMLElement[] = [];
  /** What each dot shows: 0 none, 1 pass, 2 fail; plus the ringed index. */
  private readonly dotState: number[] = [];
  private dotCurrent = -1;
  private lastIndex = -1;
  private lastName = '';
  private lastAttempts = -1;
  private lastTimerQ = -1;
  private lastTimerSec = -1;
  private lastTimerShown: boolean | null = null;
  private lastWaiting: boolean | null = null;
  private lastBoost: boolean | null = null;
  private lastPaused = false;
  private lastHints = '';
  private lastSumHint = '';
  private shotCount = 0;
  private bannerTimer = 0;

  constructor(container: HTMLElement, actions: TrainingHudActions) {
    this.container = container;
    this.actions = actions;
    this.root = el('div', 'trn-root');
    this.root.hidden = true;

    this.panel = el('div', 'trn-panel');
    this.title = el('div', 'trn-title', '');
    this.shotLine = el('div', 'trn-shot', '');
    this.attemptsLine = el('div', 'trn-attempts', '');
    this.dots = el('div', 'trn-dots');
    this.timer = el('div', 'trn-timer');
    const track = el('div', 'trn-timer-track');
    this.timerFill = el('div', 'trn-timer-fill');
    track.appendChild(this.timerFill);
    this.timerText = el('div', 'trn-timer-text', '');
    this.timer.append(track, this.timerText);
    this.boostLine = el('div', 'trn-boost', '');
    this.keys = el('div', 'trn-keys', '');
    this.panel.append(this.title, this.shotLine, this.attemptsLine, this.dots, this.timer, this.boostLine, this.keys);

    this.start = el('div', 'trn-start', 'Drive to start the shot');
    this.start.hidden = true;

    this.banner = el('div', 'trn-banner');
    this.bannerTitle = el('div', 'trn-banner-title', '');
    this.bannerSub = el('div', 'trn-banner-sub', '');
    this.banner.append(this.bannerTitle, this.bannerSub);
    this.banner.hidden = true;

    // Pause panel: shown under the Hud's PAUSED title while paused.
    this.pausePanel = el('div', 'trn-pause');
    const resume = button('trn-btn trn-btn-primary', 'Resume', () => this.actions.onResume());
    const reset = button('trn-btn', 'Reset shot', () => this.actions.onReset());
    const prev = button('trn-btn', 'Previous shot', () => this.actions.onPrev());
    const next = button('trn-btn', 'Next shot', () => this.actions.onNext());
    const resetBall = button('trn-btn', 'Reset ball', () => this.actions.onReset());
    const resetCar = button('trn-btn', 'Reset car', () => this.actions.onResetCar());
    this.boostButton = button('trn-btn', 'Unlimited boost: ON', () => this.actions.onToggleBoost());
    const quit = button('trn-btn trn-btn-quit', 'Quit training', () => this.actions.onQuit());
    this.packButtons.push(reset, prev, next);
    this.freeButtons.push(resetBall, resetCar, this.boostButton);
    this.pausePanel.append(resume, reset, prev, next, resetBall, resetCar, this.boostButton, quit);
    this.pausePanel.hidden = true;

    // Pack summary.
    this.summary = el('div', 'trn-summary');
    const card = el('div', 'trn-summary-card');
    this.sumPack = el('div', 'trn-summary-pack', '');
    const done = el('div', 'trn-summary-title', 'Pack complete');
    this.sumScore = el('div', 'trn-summary-score', '');
    this.sumBest = el('div', 'trn-summary-best', '');
    this.sumDots = el('div', 'trn-dots trn-summary-dots');
    const row = el('div', 'trn-summary-buttons');
    row.append(
      button('trn-btn trn-btn-primary', 'Retry pack', () => this.actions.onRetryPack()),
      button('trn-btn', 'Back to menu', () => this.actions.onQuit()),
    );
    this.sumHint = el('div', 'trn-summary-hint', '');
    card.append(this.sumPack, done, this.sumScore, this.sumBest, this.sumDots, row, this.sumHint);
    this.summary.appendChild(card);
    this.summary.hidden = true;

    this.root.append(this.panel, this.start, this.banner, this.pausePanel, this.summary);
    container.appendChild(this.root);
  }

  get visible(): boolean {
    return this.open;
  }

  /** Open for a pack (`shots` dots) or free play (`shots` 0). Resets every cached field. */
  show(title: string, shots: number, freeplay: boolean): void {
    this.open = true;
    this.freeplay = freeplay;
    this.shotCount = shots;
    this.root.hidden = false;
    this.container.classList.add('trn-on');
    this.root.classList.toggle('trn-freeplay', freeplay);
    this.title.textContent = title;
    this.shotLine.hidden = freeplay;
    this.attemptsLine.hidden = freeplay;
    this.dots.hidden = freeplay;
    this.timer.hidden = freeplay;
    this.boostLine.hidden = !freeplay;
    for (const b of this.packButtons) b.hidden = freeplay;
    for (const b of this.freeButtons) b.hidden = !freeplay;
    this.buildDots(this.dots, this.dotEls, shots);
    this.dotState.length = 0;
    for (let i = 0; i < shots; i++) this.dotState.push(0);
    this.dotCurrent = -1;
    this.lastIndex = -1;
    this.lastName = '';
    this.lastAttempts = -1;
    this.lastTimerQ = -1;
    this.lastTimerSec = -1;
    this.lastTimerShown = null;
    this.lastWaiting = null;
    this.lastBoost = null;
    this.hideResult();
    this.hideSummary();
    this.setPaused(false);
  }

  hide(): void {
    this.open = false;
    this.root.hidden = true;
    this.container.classList.remove('trn-on');
    this.hideResult();
    this.hideSummary();
  }

  /** Key hints (panel footer, one per line) and the summary's accept / back line; rebuilt only when a label changed. */
  setHints(h: TrainingHints): void {
    const text = this.freeplay
      ? `${h.reset}  reset ball
${h.resetCar}  reset car
${h.boost}  unlimited boost
${h.pause}  pause`
      : `${h.reset}  reset shot
${h.prev} / ${h.next}  previous / next shot
${h.pause}  pause`;
    if (text !== this.lastHints) {
      this.lastHints = text;
      this.keys.textContent = text;
    }
    const sum = `${h.accept} / ${h.reset}  retry pack   ·   ${h.back}  back to menu   ·   ${h.prev} / ${h.next}  pick a shot`;
    if (sum !== this.lastSumHint) {
      this.lastSumHint = sum;
      this.sumHint.textContent = sum;
    }
  }

  /** Current shot line, attempts and the result dots (cheap when nothing changed). */
  setShot(index: number, name: string, attempts: number, results: readonly (ShotOutcome | null)[]): void {
    if (index !== this.lastIndex || name !== this.lastName) {
      this.lastIndex = index;
      this.lastName = name;
      this.shotLine.textContent = `Shot ${index + 1} / ${this.shotCount}  ·  ${name}`;
    }
    if (attempts !== this.lastAttempts) {
      this.lastAttempts = attempts;
      this.attemptsLine.textContent = attempts === 1 ? '1 attempt' : `${attempts} attempts`;
    }
    this.syncDots(this.dotEls, results, index);
  }

  /**
   * Shot timer: `fraction` of the limit left (bar), `seconds` left (text, whole seconds rounded
   * up). `shown` false hides it (free play).
   */
  setTimer(fraction: number, seconds: number, shown: boolean): void {
    if (shown !== this.lastTimerShown) {
      this.lastTimerShown = shown;
      this.timer.classList.toggle('trn-timer-idle', !shown);
    }
    const f = fraction > 1 ? 1 : fraction > 0 ? fraction : 0;
    const q = Math.round(f * 500);
    if (q !== this.lastTimerQ) {
      this.lastTimerQ = q;
      this.timerFill.style.transform = `scaleX(${q / 500})`;
      this.timer.classList.toggle('trn-timer-low', f < 0.25);
    }
    const sec = Math.ceil(seconds - 1e-6);
    if (sec !== this.lastTimerSec) {
      this.lastTimerSec = sec;
      this.timerText.textContent = String(sec > 0 ? sec : 0);
    }
  }

  /** The "drive to start" prompt while a shot waits for the first input. */
  setWaiting(waiting: boolean): void {
    if (waiting === this.lastWaiting) return;
    this.lastWaiting = waiting;
    this.start.hidden = !waiting;
  }

  /** Free play: the unlimited boost state (panel line and pause button). */
  setBoostUnlimited(on: boolean): void {
    if (on === this.lastBoost) return;
    this.lastBoost = on;
    this.boostLine.textContent = on ? 'Unlimited boost  ON' : 'Unlimited boost  OFF';
    this.boostLine.classList.toggle('trn-boost-off', !on);
    this.boostButton.textContent = on ? 'Unlimited boost: ON' : 'Unlimited boost: OFF';
  }

  /** Success / fail banner for `ms` milliseconds (pass = green, fail = red). */
  showResult(pass: boolean, title: string, sub: string, ms: number): void {
    this.bannerTitle.textContent = title;
    this.bannerSub.textContent = sub;
    this.bannerSub.hidden = sub.length === 0;
    this.banner.classList.toggle('trn-pass', pass);
    this.banner.classList.toggle('trn-fail', !pass);
    this.banner.hidden = false;
    pop(this.banner);
    if (this.bannerTimer !== 0) window.clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => {
      this.banner.hidden = true;
      this.bannerTimer = 0;
    }, ms);
  }

  hideResult(): void {
    if (this.bannerTimer !== 0) window.clearTimeout(this.bannerTimer);
    this.bannerTimer = 0;
    this.banner.hidden = true;
  }

  /** The end-of-pack panel (also hides the result banner and the start prompt). */
  showSummary(packName: string, s: TrainingSummary, results: readonly (ShotOutcome | null)[]): void {
    this.hideResult();
    this.setWaiting(false);
    this.sumPack.textContent = packName;
    this.sumScore.textContent = `${s.passed} / ${s.total}`;
    this.sumBest.textContent = s.newBest ? 'New best!' : `Best  ${s.best} / ${s.total}`;
    this.sumBest.classList.toggle('trn-new-best', s.newBest);
    const els: HTMLElement[] = [];
    this.buildDots(this.sumDots, els, results.length);
    for (let i = 0; i < els.length; i++) this.paintDot(els[i], results[i] === 'pass' ? 1 : results[i] === 'fail' ? 2 : 0, false);
    this.summary.hidden = false;
    this.root.classList.add('trn-summary-on');
    pop(this.summary);
  }

  hideSummary(): void {
    this.summary.hidden = true;
    this.root.classList.remove('trn-summary-on');
  }

  get summaryVisible(): boolean {
    return !this.summary.hidden;
  }

  /** Training entries under the Hud's PAUSED overlay. */
  setPaused(paused: boolean): void {
    if (paused === this.lastPaused) return;
    this.lastPaused = paused;
    this.pausePanel.hidden = !paused;
    this.root.classList.toggle('trn-paused', paused);
  }

  dispose(): void {
    this.hide();
    this.root.remove();
  }

  // ---- dots -----------------------------------------------------------------------------------

  private buildDots(parent: HTMLElement, out: HTMLElement[], n: number): void {
    parent.textContent = '';
    out.length = 0;
    for (let i = 0; i < n; i++) {
      const d = el('span', 'trn-dot');
      parent.appendChild(d);
      out.push(d);
    }
  }

  private syncDots(els: readonly HTMLElement[], results: readonly (ShotOutcome | null)[], current: number): void {
    const state = this.dotState;
    for (let i = 0; i < els.length && i < results.length; i++) {
      const r = results[i];
      const v = r === 'pass' ? 1 : r === 'fail' ? 2 : 0;
      if (v !== state[i]) {
        state[i] = v;
        this.paintDot(els[i], v, i === current);
      }
    }
    if (current !== this.dotCurrent) {
      const old = this.dotCurrent;
      this.dotCurrent = current;
      if (old >= 0 && old < els.length) els[old].classList.remove('trn-dot-current');
      if (current >= 0 && current < els.length) els[current].classList.add('trn-dot-current');
    }
  }

  private paintDot(d: HTMLElement, v: number, current: boolean): void {
    d.classList.toggle('trn-dot-pass', v === 1);
    d.classList.toggle('trn-dot-fail', v === 2);
    if (current) d.classList.add('trn-dot-current');
  }
}
