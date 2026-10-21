/**
 * The loading screen: the TURBOGOL wordmark, a thin lime progress bar and at most one short line
 * ("Loading stadium…"), over an opaque backdrop. One instance for the whole page (#overlay): the
 * boot uses it from the first paint (index.html carries the same markup, so nothing flashes while
 * the bundle loads), and the Game shows it again for every long load once the menus are up (a
 * quality switch, a stadium switch: Game.withLoading).
 *
 * The bar is a `transform: scaleX()` with a CSS transition: `progress(p, ms)` eases it to `p`
 * over `ms`, so a step that blocks the main thread (a scene build, a synchronous shader compile)
 * still shows a moving bar (the compositor runs the transition). Progress never goes back.
 *
 * While it is up the page under it takes no input: the element takes the pointer, and keydown is
 * swallowed in the capture phase (Enter / Space would otherwise click the focused menu button under
 * it, the arrows would move the menu focus). Key releases pass, so a key held across a load does not
 * stay stuck. Styling: src/style.css (`ld-`), loaded before the bundle.
 */

/** Fade-in and fade-out durations (ms); src/style.css uses the same values. */
export const LOADING_FADE_IN_MS = 160;
export const LOADING_FADE_OUT_MS = 380;

/**
 * The next bar value: never back, never past 1, a NaN / infinite request keeps the current one
 * (a bad value never reaches the transform).
 */
export function nextProgress(current: number, wanted: number): number {
  if (!Number.isFinite(wanted)) return current;
  const p = wanted < 0 ? 0 : wanted > 1 ? 1 : wanted;
  return p > current ? p : current;
}

/** Resolves after the next frame has been painted (a timer when the tab gets no animation frames). */
export function afterPaint(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      resolve();
    };
    // A hidden tab never fires requestAnimationFrame: the timer keeps the work going there.
    const timer = window.setTimeout(finish, 120);
    requestAnimationFrame(() => window.setTimeout(finish, 0));
  });
}

/** `n` painted frames in a row (two: the frame that applied a style change has reached the screen). */
export async function paintedFrames(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await afterPaint();
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export class LoadingOverlay {
  readonly el: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly line: HTMLElement;
  private value = 0;
  private open: boolean;
  /** Bumped by every show / hide: a fade-out that a new show overtook does not hide it. */
  private generation = 0;

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.open) return;
    // Browser shortcuts (reload, devtools, zoom) keep working; nothing reaches the page.
    if (!e.ctrlKey && !e.metaKey && !e.altKey && !/^F\d+$/.test(e.code)) e.preventDefault();
    e.stopImmediatePropagation();
  };

  /**
   * Take over `el` (index.html's #overlay): its `.ld-*` markup when it has it, else it is built.
   * The overlay is open when it already shows (`ld-on`, the boot).
   */
  constructor(el: HTMLElement) {
    this.el = el;
    let fill = el.querySelector<HTMLElement>('.ld-fill');
    let line = el.querySelector<HTMLElement>('.ld-line');
    if (fill === null || line === null) {
      el.textContent = '';
      el.classList.add('ld');
      const box = document.createElement('div');
      box.className = 'ld-box';
      const logo = document.createElement('div');
      logo.className = 'ld-logo';
      logo.setAttribute('aria-hidden', 'true');
      const a = document.createElement('span');
      a.className = 'ld-logo-a';
      a.textContent = 'TURBO';
      const b = document.createElement('span');
      b.className = 'ld-logo-b';
      b.textContent = 'GOL';
      logo.append(a, b);
      const bar = document.createElement('div');
      bar.className = 'ld-bar';
      fill = document.createElement('div');
      fill.className = 'ld-fill';
      bar.appendChild(fill);
      line = document.createElement('div');
      line.className = 'ld-line';
      box.append(logo, bar, line);
      el.appendChild(box);
    }
    this.fill = fill;
    this.line = line;
    this.open = el.classList.contains('ld-on');
    el.setAttribute('role', 'progressbar');
    el.setAttribute('aria-valuemin', '0');
    el.setAttribute('aria-valuemax', '100');
    // The boot markup creeps the bar with a CSS animation until the bundle runs: carry on from
    // wherever it got to.
    if (fill.classList.contains('ld-creep')) {
      const m = /matrix\(([-\d.e]+)/.exec(getComputedStyle(fill).transform);
      const now = m !== null ? Number(m[1]) : 0;
      this.value = nextProgress(0, now);
      fill.style.transitionDuration = '0ms';
      fill.style.transform = `scaleX(${this.value})`;
      fill.classList.remove('ld-creep');
      // Commit that style now: the first progress() must start a transition from it, not jump.
      void getComputedStyle(fill).transform;
    }
    window.addEventListener('keydown', this.onKeyDown, true);
  }

  get visible(): boolean {
    return this.open;
  }

  /** Current bar value 0..1. */
  get progressValue(): number {
    return this.value;
  }

  /** The one short line under the bar (empty hides it). */
  label(text: string): void {
    this.line.textContent = text;
    this.el.setAttribute('aria-valuetext', text);
  }

  /** Ease the bar to `p` (0..1, never back) over `ms`. */
  progress(p: number, ms = 240): void {
    const v = nextProgress(this.value, p);
    if (v === this.value) return;
    this.value = v;
    this.fill.style.transitionDuration = `${Math.max(0, ms)}ms`;
    this.fill.style.transform = `scaleX(${v})`;
    this.el.setAttribute('aria-valuenow', String(Math.round(v * 100)));
  }

  /**
   * Fade in with `label` and the bar at 0; resolves once the overlay is on screen (fully opaque and
   * painted), so the caller's heavy work starts behind it. Already open: only the label changes.
   */
  async show(text: string): Promise<void> {
    this.label(text);
    if (this.open) return;
    this.generation++;
    this.open = true;
    this.value = 0;
    this.fill.style.transitionDuration = '0ms';
    this.fill.style.transform = 'scaleX(0)';
    this.el.removeAttribute('aria-valuenow');
    this.el.classList.add('ld-on');
    this.el.setAttribute('aria-busy', 'true');
    await paintedFrames(2);
    await wait(LOADING_FADE_IN_MS);
  }

  /**
   * Fill the bar, hold it a moment, fade out; resolves when the overlay is gone. A show() during
   * the fade wins (the overlay stays).
   */
  async hide(): Promise<void> {
    if (!this.open) return;
    const gen = ++this.generation;
    this.progress(1, 160);
    await wait(180);
    if (gen !== this.generation) return;
    this.open = false;
    this.el.classList.remove('ld-on');
    this.el.removeAttribute('aria-busy');
    await wait(LOADING_FADE_OUT_MS);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown, true);
  }
}
