/**
 * Frame and CPU statistics for `#diag` (gpuDiag.ts shows them, one JSON line per 5 s goes to the
 * console): the frame rate over the last second (its slowest frame and its mean) and over the last
 * five, the frames over 50 and 100 ms since the warm-up, and the CPU milliseconds per drawn frame
 * of the ball prediction (mean and the worst frame: it is spiky, a full re-prediction after a
 * touch), the bots, the physics step and the render call. Fed by the Game only when `#diag` is on
 * (`diagStats` is null otherwise: one null test per measured call, no clock read). Pure: the
 * caller passes the times.
 */

export type CpuKind = 'pred' | 'bots' | 'step' | 'render';
const KINDS: readonly CpuKind[] = ['pred', 'bots', 'step', 'render'];

export interface FrameStatsView {
  /** Over the last whole second: 1000 / its longest interval, and its frames per second. */
  readonly fpsMin1: number;
  readonly fpsAvg1: number;
  /** Frames per second over the last whole 5 s. */
  readonly fpsAvg5: number;
  /** Frames over 50 / 100 ms since the warm-up (markWarm). */
  readonly over50: number;
  readonly over100: number;
  /** CPU ms per drawn frame over the last second (mean), and the worst frame of the prediction. */
  readonly cpu: Readonly<Record<CpuKind, number>>;
  readonly predMax: number;
}

export class FrameStats {
  private last = -1;
  private warm = false;
  private over50 = 0;
  private over100 = 0;
  // the open 1 s and 5 s windows
  private w1Start = -1;
  private w1Frames = 0;
  private w1Max = 0;
  private w5Start = -1;
  private w5Frames = 0;
  // CPU: this frame's buckets, the open second's sums
  private readonly frameCpu: Record<CpuKind, number> = { pred: 0, bots: 0, step: 0, render: 0 };
  private readonly sumCpu: Record<CpuKind, number> = { pred: 0, bots: 0, step: 0, render: 0 };
  private predMaxOpen = 0;
  private view: { -readonly [K in keyof FrameStatsView]: FrameStatsView[K] } = {
    fpsMin1: 0,
    fpsAvg1: 0,
    fpsAvg5: 0,
    over50: 0,
    over100: 0,
    cpu: { pred: 0, bots: 0, step: 0, render: 0 },
    predMax: 0,
  };

  /** CPU time of one measured call in the current frame. */
  add(kind: CpuKind, ms: number): void {
    if (ms > 0) this.frameCpu[kind] += ms;
  }

  /** The warm-up is over: the long-frame counters start (the boot's and a load's frames are not play). */
  markWarm(): void {
    this.warm = true;
    this.over50 = 0;
    this.over100 = 0;
  }

  /** A drawn frame at `t` (ms, the rAF timestamp): closes the previous frame's CPU buckets. */
  frame(t: number): void {
    const p = this.frameCpu;
    for (const k of KINDS) this.sumCpu[k] += p[k];
    if (p.pred > this.predMaxOpen) this.predMaxOpen = p.pred;
    for (const k of KINDS) p[k] = 0;
    if (this.last >= 0) {
      const dt = t - this.last;
      if (dt > 0) {
        if (this.warm) {
          if (dt > 50) this.over50++;
          if (dt > 100) this.over100++;
        }
        if (dt > this.w1Max) this.w1Max = dt;
      }
    }
    this.last = t;
    if (this.w1Start < 0) this.w1Start = t;
    if (this.w5Start < 0) this.w5Start = t;
    this.w1Frames++;
    this.w5Frames++;
    const e1 = t - this.w1Start;
    if (e1 >= 1000) {
      const n = Math.max(1, this.w1Frames - 1);
      this.view.fpsAvg1 = ((this.w1Frames - 1) * 1000) / e1;
      this.view.fpsMin1 = this.w1Max > 0 ? 1000 / this.w1Max : 0;
      const cpu = this.view.cpu as Record<CpuKind, number>;
      for (const k of KINDS) {
        cpu[k] = this.sumCpu[k] / n;
        this.sumCpu[k] = 0;
      }
      this.view.predMax = this.predMaxOpen;
      this.predMaxOpen = 0;
      this.w1Start = t;
      this.w1Frames = 1;
      this.w1Max = 0;
    }
    const e5 = t - this.w5Start;
    if (e5 >= 5000) {
      this.view.fpsAvg5 = ((this.w5Frames - 1) * 1000) / e5;
      this.w5Start = t;
      this.w5Frames = 1;
    }
    this.view.over50 = this.over50;
    this.view.over100 = this.over100;
  }

  /** The figures of the last whole windows (the same object every call). */
  snapshot(): FrameStatsView {
    return this.view;
  }
}

/** The page's statistics while `#diag` is on (Game feeds, gpuDiag reads), else null. */
export let diagStats: FrameStats | null = null;

export function enableDiagStats(): FrameStats {
  if (diagStats === null) diagStats = new FrameStats();
  return diagStats;
}

/** What #diag reads from the game besides the frame figures (set by the Game; defaults while it is not up). */
export const diagSources: { wasmBytes: () => number } = { wasmBytes: () => 0 };
