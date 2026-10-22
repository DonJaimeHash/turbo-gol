/**
 * "Latest wins" serialised async work: the world's bakes and cache reads (World.ts). `request`
 * records the newest wish; one drain loop at a time runs `work` for the newest wish until the last
 * finished one matches it, so a burst of theme / tier switches costs at most the bake in flight
 * plus one for the final wish. A request that matches what is already done costs nothing.
 *
 * The loop's promise is kept only while the loop is really running. An async function whose body
 * finishes without awaiting runs its `finally` synchronously, BEFORE the caller stores the promise
 * it returns: storing it unconditionally would leave a settled promise as "the running loop" and
 * every later request would return it without doing any work (a tier switch between two tiers
 * with the same bake sizes did exactly that, and the world never re-baked again).
 */

export interface LatestQueue<T> {
  /** The newest wish. */
  readonly wanted: T;
  /** Ask for `want`; resolves once the work has caught up with the newest wish (never rejects). */
  request(want: T): Promise<void>;
}

export interface LatestQueueOptions {
  /** False once the owner is disposed: the loop stops and requests do nothing. */
  readonly alive: () => boolean;
  /** A failed `work` (logged by the owner; the loop goes on with the newest wish). */
  readonly onError: (err: unknown) => void;
}

/** A queue that starts with nothing done; `same` says when two wishes need the same work. */
export function createLatestQueue<T>(initial: T, same: (a: T, b: T) => boolean, work: (want: T) => Promise<void>, opts: LatestQueueOptions): LatestQueue<T> {
  let wanted = initial;
  let done: { readonly want: T } | null = null;
  let running: Promise<void> | null = null;
  let draining = false;

  const caughtUp = (): boolean => done !== null && same(done.want, wanted);

  async function drain(): Promise<void> {
    draining = true;
    try {
      while (opts.alive() && !caughtUp()) {
        const w = wanted;
        try {
          await work(w);
        } catch (err) {
          if (opts.alive()) opts.onError(err);
        }
        done = { want: w };
      }
    } finally {
      draining = false;
      running = null;
    }
  }

  return {
    get wanted() {
      return wanted;
    },
    request(want) {
      wanted = want;
      if (running !== null) return running;
      if (!opts.alive() || caughtUp()) return Promise.resolve();
      const p = drain();
      // a loop that already finished (synchronously) must not be kept as the running one
      if (draining) running = p;
      return p;
    },
  };
}
