/**
 * Dynamic resolution: a small pure controller (no three, no DOM, nothing allocated per frame) that
 * holds the display's refresh rate by moving the scene pass' resolution scale between a tier's
 * `minResolutionScale` and 1. The Renderer feeds it every presented frame and applies the scale
 * with PassNode.setResolutionScale, so the composite upsamples the scene (bloom, the vignette and
 * FXAA keep working on the full-size output).
 *
 *   refresh   estimated from the frame intervals: the 10th percentile of each 1 s window (early
 *             frames and timer jitter below it are ignored; a histogram of 0.25 ms bins). A
 *             shorter window replaces the estimate at once; a longer one pulls it up by a quarter
 *             per window, but only while a lower resolution has nothing to give (at the minimum
 *             scale, after a failed probe, or with the GPU idle): a slower display, a throttled
 *             tab or a CPU-bound game then stops counting as late.
 *   late      a frame at 1.4 refresh intervals or more (a missed vsync is 2). Decisions are made
 *             per 0.5 s window from the share of late frames and the mean interval.
 *   down      a window with a quarter of its frames late starts a probe: one step down (0.1) per
 *             late window. The probe succeeds as soon as frames get 10 % faster than before it
 *             (or stop being late). If it reaches the minimum without that, the frames are not
 *             held back by the resolution (CPU-bound, a capped frame rate): the scale goes back
 *             to where the probe started and no probe runs for 30 s (doubling up to 4 min).
 *   up        3 s of windows with at most 5 % late frames: one step up (0.05). Between 5 % and a
 *             quarter nothing moves (hysteresis). A step up that turns late within 8 s is undone
 *             (0.05 down, no probe) and marks that scale as the ceiling: the next try at or above
 *             it waits twice as long (up to 48 s), and a try that holds for 8 s clears it. So a
 *             load just above a step costs one short stutter per try, and the tries back off
 *             instead of oscillating.
 *   GPU time  when known (`#stats` timestamps): no probe while the GPU used less than 60 % of the
 *             refresh (the CPU or a hitch, which a lower resolution won't fix), and a step up only
 *             if the GPU time scaled to the next step stays under 80 % of the refresh.
 *
 * Intervals over 100 ms are ignored: a hidden or background tab, a breakpoint, a shader compile or
 * the first frame after a stall say nothing about the load; so is the first second after a reset
 * (the warm-up frames of a tier switch), and the longest interval of each window is left out of
 * its mean (the render-target reallocation of a scale change). The scale stays on a 0.05 grid, so
 * the scene pass sees only a few render-target sizes.
 *
 * Limits (tuning is the integration phase of docs/visuals/REWORK.md): the refresh is only seen
 * through the game's own frames, so a game that is already slower than the display from its first
 * second (72 fps on a 144 Hz screen) takes that rate for the refresh and stays at full resolution;
 * and frames over MAX_INTERVAL_MS (under 10 fps) never count, so the scale cannot rescue them.
 */

/** Intervals longer than this (ms) are not load: ignored. */
const MAX_INTERVAL_MS = 100;
/** Bounds of the refresh estimate (ms): 360 Hz up to the longest interval counted. */
const MIN_REFRESH_MS = 1000 / 360;
/** Refresh estimate before the first window (ms). */
const DEFAULT_REFRESH_MS = 1000 / 60;
/** Refresh-estimate window (s) and the share a longer window pulls the estimate up. */
const REFRESH_WINDOW_S = 1;
const RISE = 0.25;
/** The estimate is this percentile of a window's intervals, read from a histogram of BIN_MS bins. */
const REFRESH_PERCENTILE = 0.1;
const BIN_MS = 0.25;
const BINS = Math.ceil(MAX_INTERVAL_MS / BIN_MS) + 1;
/** Decision window (s). */
const WINDOW_S = 0.5;
/** No decision for this long (s) after a reset. */
const SETTLE_S = 1;
/** A frame is late at this many refresh intervals or more. */
const LATE_FACTOR = 1.4;
/** Late share of a window that steps down, and the share at or under which it counts as headroom. */
const DOWN_SHARE = 0.25;
const UP_SHARE = 0.05;
/** A probe succeeds once the mean interval falls to this share of the one before it. */
const HELPED = 0.9;
/** No probe for this long (s) after one failed; doubles up to BACKOFF_MAX_S. */
const BACKOFF_S = 30;
const BACKOFF_MAX_S = 240;
/** Seconds of headroom before a step up; the wait doubles at a ceiling, up to UP_AFTER_MAX_S. */
const UP_AFTER_S = 3;
const UP_AFTER_MAX_S = 48;
/** A late window within this many seconds of a step up undoes it (a bounce). */
const BOUNCE_WINDOW_S = 8;
/** Scale steps: down fast, up slow; the scale stays on a grid of 1 / GRID. */
const GRID = 20;
const DOWN_STEP = 2 / GRID;
const UP_STEP = 1 / GRID;
/** With GPU timing: a step up only when the GPU time at the next scale fits this share of the refresh. */
const GPU_HEADROOM = 0.8;
/** With GPU timing: no probe while the GPU used less than this share of the refresh. */
const GPU_BOUND = 0.6;

/** Round to the scale grid (two decimals at most, as the stats line shows them). */
function snap(v: number): number {
  return Math.round(v * GRID) / GRID;
}

function clampMin(minScale: number): number {
  return Math.min(1, Math.max(0.1, minScale));
}

export class DynamicResolution {
  /** Current scene-pass resolution scale (1 = full resolution). */
  scale = 1;
  /** Estimated display refresh interval (ms). */
  refreshMs = DEFAULT_REFRESH_MS;

  private minScale: number;
  /** Seconds of counted frames since the last reset. */
  private clock = 0;
  /** Refresh window: elapsed seconds, frames and the interval histogram. */
  private refreshS = 0;
  private refreshFrames = 0;
  private readonly bins = new Uint32Array(BINS);
  /** The refresh estimate may rise (a lower resolution has nothing to give right now). */
  private mayRise = false;
  /** Decision window: elapsed seconds, frames, late frames, interval sum and longest interval. */
  private windowS = 0;
  private frames = 0;
  private lateFrames = 0;
  private sumMs = 0;
  private maxMs = 0;
  /** Running probe: the scale it started from (-1 = none) and the mean interval before it. */
  private probeFrom = -1;
  private probeBaseMs = 0;
  private backoffUntil = 0;
  private backoffS = BACKOFF_S;
  /** Headroom seconds in a row, clock of the last step up (-1 = none in the bounce window). */
  private headroom = 0;
  private lastUpAt = -1;
  /** Lowest scale that bounced (Infinity = none) and the wait before trying it again. */
  private ceiling = Infinity;
  private upAfter = UP_AFTER_S;

  /** `minScale`: the tier's minResolutionScale (1 = the scale never moves). */
  constructor(minScale = 1) {
    this.minScale = clampMin(minScale);
  }

  /** A new range (a tier switch): back to full resolution with a fresh history; the refresh estimate stays. */
  reset(minScale: number): void {
    this.minScale = clampMin(minScale);
    this.scale = 1;
    this.clock = 0;
    this.mayRise = false;
    this.windowS = 0;
    this.frames = 0;
    this.lateFrames = 0;
    this.sumMs = 0;
    this.maxMs = 0;
    this.probeFrom = -1;
    this.backoffUntil = 0;
    this.backoffS = BACKOFF_S;
    this.headroom = 0;
    this.lastUpAt = -1;
    this.ceiling = Infinity;
    this.upAfter = UP_AFTER_S;
  }

  /**
   * One presented frame: `intervalMs` since the previous one and `gpuMs`, its GPU time (NaN or 0
   * when unknown). Returns true when `scale` changed.
   */
  update(intervalMs: number, gpuMs: number): boolean {
    if (!(intervalMs > 0) || intervalMs > MAX_INTERVAL_MS) return false;
    const dt = intervalMs * 0.001;
    this.clock += dt;
    this.trackRefresh(intervalMs, dt);
    if (this.minScale >= 1) return false;
    this.frames++;
    this.sumMs += intervalMs;
    if (intervalMs > this.maxMs) this.maxMs = intervalMs;
    if (intervalMs >= this.refreshMs * LATE_FACTOR) this.lateFrames++;
    this.windowS += dt;
    if (this.windowS < WINDOW_S) return false;
    const n = this.frames;
    const meanMs = n > 1 ? (this.sumMs - this.maxMs) / (n - 1) : this.sumMs;
    const lateShare = this.lateFrames / n;
    const windowS = this.windowS;
    this.windowS = 0;
    this.frames = 0;
    this.lateFrames = 0;
    this.sumMs = 0;
    this.maxMs = 0;
    if (this.clock < SETTLE_S) return false;
    return this.decide(meanMs, lateShare, windowS, gpuMs > 0 && Number.isFinite(gpuMs) ? gpuMs : -1);
  }

  /** One decision window; `gpuMs` < 0 when unknown. */
  private decide(meanMs: number, lateShare: number, windowS: number, gpuMs: number): boolean {
    const refresh = this.refreshMs;
    const gpuIdle = gpuMs >= 0 && gpuMs < refresh * GPU_BOUND;
    const late = lateShare >= DOWN_SHARE;
    let changed = false;

    if (this.probeFrom > 0) {
      if (!late || meanMs <= this.probeBaseMs * HELPED) {
        // Frames got faster: the resolution was the limit. Probes may run again at once.
        this.probeFrom = -1;
        this.backoffS = BACKOFF_S;
      } else if (this.scale <= this.minScale) {
        // At the minimum and no faster: not the resolution. Back to the start, and wait.
        this.scale = this.probeFrom;
        this.probeFrom = -1;
        this.backoffUntil = this.clock + this.backoffS;
        this.backoffS = Math.min(BACKOFF_MAX_S, this.backoffS * 2);
        this.headroom = 0;
        changed = true;
      }
    }
    const backedOff = this.clock < this.backoffUntil;
    this.mayRise = this.scale <= this.minScale || backedOff || gpuIdle;
    if (changed) return true;

    if (late) {
      this.headroom = 0;
      if (this.scale <= this.minScale || backedOff || gpuIdle) return false;
      return this.stepDown(meanMs);
    }

    // A step up that held for the whole bounce window clears the ceiling it reached.
    if (this.lastUpAt >= 0 && this.clock - this.lastUpAt >= BOUNCE_WINDOW_S) {
      if (this.scale >= this.ceiling) {
        this.ceiling = Infinity;
        this.upAfter = UP_AFTER_S;
      }
      this.lastUpAt = -1;
    }
    if (this.scale >= 1) return false;
    const next = Math.min(1, snap(this.scale + UP_STEP));
    const k = next / this.scale;
    if (lateShare > UP_SHARE || (gpuMs >= 0 && gpuMs * k * k > refresh * GPU_HEADROOM)) {
      this.headroom = 0;
      return false;
    }
    this.headroom += windowS;
    if (this.headroom < (next >= this.ceiling ? this.upAfter : UP_AFTER_S)) return false;
    this.headroom = 0;
    this.scale = next;
    this.lastUpAt = this.clock;
    return true;
  }

  /** One step down: undoes a recent step up (a bounce), else starts or continues a probe. */
  private stepDown(meanMs: number): boolean {
    let step = DOWN_STEP;
    if (this.lastUpAt >= 0 && this.clock - this.lastUpAt < BOUNCE_WINDOW_S) {
      // That scale is too much for now: back to the one that held, and wait longer next time.
      if (this.scale <= this.ceiling) this.upAfter = Math.min(UP_AFTER_MAX_S, this.upAfter * 2);
      this.ceiling = Math.min(this.ceiling, this.scale);
      step = UP_STEP;
    } else if (this.probeFrom < 0) {
      this.probeFrom = this.scale;
      this.probeBaseMs = meanMs;
    }
    this.lastUpAt = -1;
    this.headroom = 0;
    this.scale = Math.max(this.minScale, snap(this.scale - step));
    return true;
  }

  /** Windowed low percentile of the intervals: the estimate falls to it at once; while mayRise it rises by RISE per window. */
  private trackRefresh(intervalMs: number, dt: number): void {
    this.bins[Math.min(BINS - 1, Math.floor(intervalMs / BIN_MS))]++;
    this.refreshFrames++;
    this.refreshS += dt;
    if (this.refreshS < REFRESH_WINDOW_S) return;
    // The bin where REFRESH_PERCENTILE of the window's frames is reached (at least two frames).
    const k = Math.min(this.refreshFrames, Math.max(2, Math.ceil(this.refreshFrames * REFRESH_PERCENTILE)));
    let seen = 0;
    let w = MAX_INTERVAL_MS;
    for (let i = 0; i < BINS; i++) {
      seen += this.bins[i];
      if (seen >= k) {
        w = (i + 0.5) * BIN_MS;
        break;
      }
    }
    const est = w < this.refreshMs ? w : this.mayRise ? this.refreshMs + (w - this.refreshMs) * RISE : this.refreshMs;
    this.refreshMs = Math.min(MAX_INTERVAL_MS, Math.max(MIN_REFRESH_MS, est));
    this.refreshS = 0;
    this.refreshFrames = 0;
    this.bins.fill(0);
  }
}
