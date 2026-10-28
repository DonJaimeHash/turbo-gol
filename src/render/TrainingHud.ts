/**
 * Training HUD (free play and shot packs, src/game/TrainingSession.ts): a DOM overlay next to the
 * match Hud, styled by ./training.css (classes prefixed `trn-`).
 *
 *   top left      pack name, "Shot n / N · <shot name>", attempts, one dot per shot by shape (✓
 *                 passed, ✕ missed, hollow to play; the current one ringed), the hits and misses
 *                 so far and the shot timer bar; free play shows its unlimited-boost state
 *                 instead (experimental free play also "Rules: <preset>", setRules); under it the
 *                 training key hints, from the live bindings of the device in use (a finger: the
 *                 ↺ button and the pause), kept in the panel (the bottom centre belongs to the
 *                 Hud's pointer-lock hint and camera mode). The panel folds after FOLD_MS: the
 *                 hints and the attempts step aside, the shot, its dots and the clock stay
 *   centre        "drive to start" while a shot waits for the first input, the success / fail
 *                 banner, the pack summary (passed / total, best, the dots, AGAIN · NEXT LEVEL ·
 *                 TRAINING: a FocusNav of its own, which the Game drives with the arrows / D-pad
 *                 and Enter / A while it is up, and a click or a tap)
 *   pause         the Hud's pause menu carries the training entries (Reset shot / Previous /
 *                 Next, free play: Reset ball / Reset car / Unlimited boost; built by the Game);
 *                 while it is up this overlay only hides its key hints and the "drive" prompt
 *
 * While open it puts `trn-on` on its container so training.css can hide the match score / clock.
 * Like the Hud, every per-frame setter caches what it last wrote and touches the DOM only on a
 * change: calling them every frame allocates nothing. Buttons are real <button>s: Input ignores
 * presses on them (they are UI, not boost / jump) and the canvas never sees the click.
 */
import './training.css';
import type { ShotOutcome, TrainingSummary } from '../game/TrainingSession';
import { t } from '../i18n';
import { FocusNav } from '../ui/nav';
import type { NavDir } from '../ui/nav';

/** The panel folds this long after a pack or free play opens (plan PR 13). */
const FOLD_MS = 10_000;

/** What the pack summary's buttons do (the Game wires them to the session). */
export interface TrainingHudActions {
  onRetryPack(): void;
  /** The same category's next level (the summary shows the button only when there is one). */
  onNextLevel(): void;
  /** Leave training for the menu (ENTRENAMIENTO). */
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
  /** The device in use: a finger gets the ↺ button and the pause instead of keys. */
  device: 'kbm' | 'pad' | 'touch';
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
  b.setAttribute('data-nav', '');
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
  /** Experimental free play's "Rules: <preset>" (hidden otherwise). */
  private readonly rulesLine: HTMLElement;
  private readonly shotLine: HTMLElement;
  private readonly attemptsLine: HTMLElement;
  private readonly dots: HTMLElement;
  /** "✓ 3 · ✕ 1": the hits and misses of this run. */
  private readonly tally: HTMLElement;
  private readonly timer: HTMLElement;
  private readonly timerFill: HTMLElement;
  private readonly timerText: HTMLElement;
  private readonly boostLine: HTMLElement;
  private readonly start: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly bannerTitle: HTMLElement;
  private readonly bannerSub: HTMLElement;
  private readonly keys: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly sumPack: HTMLElement;
  private readonly sumScore: HTMLElement;
  private readonly sumBest: HTMLElement;
  private readonly sumDots: HTMLElement;
  private readonly sumHint: HTMLElement;
  private readonly sumAgain: HTMLButtonElement;
  private readonly sumNext: HTMLButtonElement;
  /** The summary's own focus: the Game's arrows / D-pad and Enter / A while it is up. */
  private readonly sumNav: FocusNav;
  /** The unlimited boost texts of the panel line, built once. */
  private readonly boostText: { lineOn: string; lineOff: string };

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
  private foldTimer = 0;
  private lastTally = '';

  constructor(container: HTMLElement, actions: TrainingHudActions) {
    this.container = container;
    this.actions = actions;
    this.root = el('div', 'trn-root');
    this.root.hidden = true;
    this.boostText = {
      lineOn: t('trainingHud.boostLineOn'),
      lineOff: t('trainingHud.boostLineOff'),
    };

    this.panel = el('div', 'trn-panel');
    this.title = el('div', 'trn-title', '');
    this.rulesLine = el('div', 'trn-rules', '');
    this.rulesLine.hidden = true;
    this.shotLine = el('div', 'trn-shot', '');
    this.attemptsLine = el('div', 'trn-attempts', '');
    this.dots = el('div', 'trn-dots');
    this.tally = el('div', 'trn-tally', '');
    this.timer = el('div', 'trn-timer');
    const track = el('div', 'trn-timer-track');
    this.timerFill = el('div', 'trn-timer-fill');
    track.appendChild(this.timerFill);
    this.timerText = el('div', 'trn-timer-text', '');
    this.timer.append(track, this.timerText);
    this.boostLine = el('div', 'trn-boost', '');
    this.keys = el('div', 'trn-keys', '');
    this.panel.append(this.title, this.rulesLine, this.shotLine, this.attemptsLine, this.dots, this.tally, this.timer, this.boostLine, this.keys);

    this.start = el('div', 'trn-start', t('trainingHud.start'));
    this.start.hidden = true;

    this.banner = el('div', 'trn-banner');
    this.bannerTitle = el('div', 'trn-banner-title', '');
    this.bannerSub = el('div', 'trn-banner-sub', '');
    this.banner.append(this.bannerTitle, this.bannerSub);
    this.banner.hidden = true;

    // Pack summary.
    this.summary = el('div', 'trn-summary');
    const card = el('div', 'trn-summary-card');
    this.sumPack = el('div', 'trn-summary-pack', '');
    const done = el('div', 'trn-summary-title', t('trainingHud.packComplete'));
    this.sumScore = el('div', 'trn-summary-score', '');
    this.sumBest = el('div', 'trn-summary-best', '');
    this.sumDots = el('div', 'trn-dots trn-summary-dots');
    const row = el('div', 'trn-summary-buttons');
    row.setAttribute('data-nav-row', '');
    this.sumAgain = button('trn-btn trn-btn-primary', t('trainingHud.again'), () => this.actions.onRetryPack());
    this.sumAgain.setAttribute('data-autofocus', '');
    this.sumNext = button('trn-btn', t('trainingHud.nextLevel'), () => this.actions.onNextLevel());
    row.append(this.sumAgain, this.sumNext, button('trn-btn', t('trainingHud.toTraining'), () => this.actions.onQuit()));
    this.sumHint = el('div', 'trn-summary-hint', '');
    card.append(this.sumPack, done, this.sumScore, this.sumBest, this.sumDots, row, this.sumHint);
    this.summary.appendChild(card);
    this.summary.hidden = true;
    this.sumNav = new FocusNav(() => (this.summary.hidden ? [] : [{ name: 'summary', el: card, main: true }]));
    this.sumNav.install(card);
    // Enter on a focused button would click it natively too: the Game's accept edge presses it (summaryAccept).
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.preventDefault();
    });

    this.root.append(this.panel, this.start, this.banner, this.summary);
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
    this.setRules(null);
    this.shotLine.hidden = freeplay;
    this.attemptsLine.hidden = freeplay;
    this.dots.hidden = freeplay;
    this.timer.hidden = freeplay;
    this.boostLine.hidden = !freeplay;
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
    this.lastTally = '';
    this.tally.hidden = freeplay;
    this.hideResult();
    this.hideSummary();
    this.setPaused(false);
    this.fold(false);
    this.foldTimer = window.setTimeout(() => this.fold(true), FOLD_MS);
  }

  /** The panel folded (FOLD_MS after it opened: the hints and the attempts step aside) or whole. */
  private fold(on: boolean): void {
    if (this.foldTimer !== 0) window.clearTimeout(this.foldTimer);
    this.foldTimer = 0;
    this.panel.classList.toggle('trn-folded', on);
  }

  /** The panel's title (experimental free play turning plain: the rules went). */
  setTitle(title: string): void {
    if (this.title.textContent !== title) this.title.textContent = title;
  }

  /** Experimental free play's rules line ("Rules: Low gravity"); null hides it. Not per frame: on a change of rules. */
  setRules(text: string | null): void {
    this.rulesLine.hidden = text === null;
    this.rulesLine.textContent = text ?? '';
  }

  hide(): void {
    this.open = false;
    this.root.hidden = true;
    this.container.classList.remove('trn-on');
    this.fold(false);
    this.hideResult();
    this.hideSummary();
  }

  /**
   * Key hints (panel footer, one per line) and the summary's accept / back line; rewritten only
   * when a label changed. Not per frame: the Game calls it when the device in use changes.
   */
  setHints(h: TrainingHints): void {
    const touch = h.device === 'touch';
    const text = touch
      ? [t(this.freeplay ? 'trainingHud.touchResetAll' : 'trainingHud.keyResetShot', { key: '↺' }), t(this.freeplay ? 'trainingHud.touchPauseFree' : 'trainingHud.touchPausePack')].join('\n')
      : this.freeplay
        ? [
            t('trainingHud.keyResetBall', { key: h.reset }),
            t('trainingHud.keyResetCar', { key: h.resetCar }),
            t('trainingHud.keyBoost', { key: h.boost }),
            t('trainingHud.keyPause', { key: h.pause }),
          ].join('\n')
        : [
            t('trainingHud.keyResetShot', { key: h.reset }),
            t('trainingHud.keyPrevNext', { prev: h.prev, next: h.next }),
            t('trainingHud.keyPause', { key: h.pause }),
          ].join('\n');
    if (text !== this.lastHints) {
      this.lastHints = text;
      this.keys.textContent = text;
    }
    // A controller's D-pad ◀ ▶ walk the summary's buttons (no shot picking there); a finger taps them.
    const sum = touch ? '' : t(h.device === 'pad' ? 'trainingHud.summaryHintPad' : 'trainingHud.summaryHint', { reset: h.reset, back: h.back, prev: h.prev, next: h.next });
    if (sum !== this.lastSumHint) {
      this.lastSumHint = sum;
      this.sumHint.textContent = sum;
      this.sumHint.hidden = sum === '';
    }
  }

  /** Current shot line, attempts and the result dots (cheap when nothing changed). */
  setShot(index: number, name: string, attempts: number, results: readonly (ShotOutcome | null)[]): void {
    if (index !== this.lastIndex || name !== this.lastName) {
      this.lastIndex = index;
      this.lastName = name;
      this.shotLine.textContent = t('trainingHud.shot', { index: index + 1, total: this.shotCount, name });
    }
    if (attempts !== this.lastAttempts) {
      this.lastAttempts = attempts;
      this.attemptsLine.textContent = t('trainingHud.attempts', { count: attempts });
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

  /** Free play: the unlimited boost state (the panel line). */
  setBoostUnlimited(on: boolean): void {
    if (on === this.lastBoost) return;
    this.lastBoost = on;
    const b = this.boostText;
    this.boostLine.textContent = on ? b.lineOn : b.lineOff;
    this.boostLine.classList.toggle('trn-boost-off', !on);
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

  /**
   * The end-of-pack panel (also hides the result banner and the start prompt). `next`: the next
   * level's name for NEXT LEVEL, null after the hardest (the button goes). AGAIN takes the focus
   * (but on a touch screen, which shows no ring).
   */
  showSummary(packName: string, s: TrainingSummary, results: readonly (ShotOutcome | null)[], next: string | null): void {
    this.hideResult();
    this.setWaiting(false);
    this.sumPack.textContent = packName;
    this.sumScore.textContent = `${s.passed} / ${s.total}`;
    this.sumBest.textContent = s.newBest ? t('trainingHud.newBest') : t('trainingHud.best', { best: s.best, total: s.total });
    this.sumBest.classList.toggle('trn-new-best', s.newBest);
    const els: HTMLElement[] = [];
    this.buildDots(this.sumDots, els, results.length);
    for (let i = 0; i < els.length; i++) this.paintDot(els[i], results[i] === 'pass' ? 1 : results[i] === 'fail' ? 2 : 0, false);
    this.sumNext.hidden = next === null;
    this.sumNext.title = next ?? '';
    this.summary.hidden = false;
    this.root.classList.add('trn-summary-on');
    pop(this.summary);
    this.sumNav.reset();
    if (!document.documentElement.classList.contains('tg-touch')) this.sumNav.focus(this.sumAgain);
  }

  hideSummary(): void {
    const a = document.activeElement;
    if (a instanceof HTMLElement && this.summary.contains(a)) a.blur();
    this.summary.hidden = true;
    this.root.classList.remove('trn-summary-on');
  }

  /** The summary's arrows / D-pad (`repeat`: a held one's auto-repeat). */
  summaryMove(dir: NavDir, repeat = false): void {
    if (!this.summary.hidden) this.sumNav.move(dir, repeat);
  }

  /** Enter / A on the summary: its focused button (AGAIN when none has the focus yet). */
  summaryAccept(): void {
    if (this.summary.hidden) return;
    if (this.sumNav.current === null) this.sumAgain.click();
    else this.sumNav.accept();
  }

  get summaryVisible(): boolean {
    return !this.summary.hidden;
  }

  /** Paused (the Hud's pause menu is up): the key hints and the "drive" prompt step aside. */
  setPaused(paused: boolean): void {
    if (paused === this.lastPaused) return;
    this.lastPaused = paused;
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
    let changed = this.lastTally === '';
    for (let i = 0; i < els.length && i < results.length; i++) {
      const r = results[i];
      const v = r === 'pass' ? 1 : r === 'fail' ? 2 : 0;
      if (v !== state[i]) {
        state[i] = v;
        changed = true;
        this.paintDot(els[i], v, i === current);
      }
    }
    if (changed) {
      let hits = 0;
      let misses = 0;
      for (let i = 0; i < state.length; i++) {
        if (state[i] === 1) hits++;
        else if (state[i] === 2) misses++;
      }
      this.lastTally = t('trainingHud.tally', { hits, misses });
      this.tally.textContent = this.lastTally;
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
