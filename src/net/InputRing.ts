/**
 * Ring of the local player's packed inputs (6 int8 per tick, types.ts packControls) indexed by
 * authoritative tick: the prediction replays from it after a snapshot and the input sender
 * resends from it until the host acknowledges. Capacity INPUT_RING ticks (~2.1 s at 120 Hz);
 * older ticks are overwritten. Allocation-free after construction.
 */
import { PACKED_INPUT_BYTES } from '../sim/types';

export const INPUT_RING = 256;
const MASK = INPUT_RING - 1;

export class InputRing {
  /** INPUT_RING x 6 int8; the slot of tick t starts at (t & 255) * 6 (check has(t) first). */
  readonly data = new Int8Array(INPUT_RING * PACKED_INPUT_BYTES);
  /** Newest tick stored (-1 = empty). */
  newestTick = -1;
  private readonly ticks = new Int32Array(INPUT_RING).fill(-1);

  /** Store the 6 bytes at `src[off..off+6)` as the input of `tick`. */
  set(tick: number, src: Int8Array, off: number): void {
    const slot = tick & MASK;
    const base = slot * PACKED_INPUT_BYTES;
    const d = this.data;
    for (let i = 0; i < PACKED_INPUT_BYTES; i++) d[base + i] = src[off + i];
    this.ticks[slot] = tick;
    if (tick > this.newestTick) this.newestTick = tick;
  }

  has(tick: number): boolean {
    return tick >= 0 && this.ticks[tick & MASK] === tick;
  }

  /** Byte offset of `tick` inside `data` (only meaningful when has(tick)). */
  offsetOf(tick: number): number {
    return (tick & MASK) * PACKED_INPUT_BYTES;
  }

  /** Copy the input of `tick` to `dst[off..off+6)`; false (dst untouched) when it is not stored. */
  copyTo(tick: number, dst: Int8Array, off: number): boolean {
    if (!this.has(tick)) return false;
    const base = (tick & MASK) * PACKED_INPUT_BYTES;
    const d = this.data;
    for (let i = 0; i < PACKED_INPUT_BYTES; i++) dst[off + i] = d[base + i];
    return true;
  }

  clear(): void {
    this.ticks.fill(-1);
    this.newestTick = -1;
  }
}

/** Ticks every input packet carries at least (the newest two: one packet per two ticks). */
export const INPUT_MIN_PER_PACKET = 2;
/** Redundancy cap: unacknowledged ticks older than this are left to the host's hold-last-input. */
export const INPUT_MAX_PER_PACKET = 16;

/**
 * Assemble the inputs for one packet: the newest INPUT_MIN_PER_PACKET ticks plus every stored tick
 * newer than `ackedInputTick` (the host's lastInputTick), at most `cap` ticks, oldest first into
 * `out`. Returns the tick count (0 when the ring is empty); the first tick is
 * `ring.newestTick - count + 1`. A gap in the ring (an older tick overwritten or never stored)
 * ends the run. Allocation-free.
 */
export function assembleInputs(ring: InputRing, ackedInputTick: number, out: Int8Array, cap = INPUT_MAX_PER_PACKET): number {
  const newest = ring.newestTick;
  if (newest < 0) return 0;
  let want = newest - ackedInputTick;
  if (want < INPUT_MIN_PER_PACKET) want = INPUT_MIN_PER_PACKET;
  if (want > cap) want = cap;
  if (want > newest + 1) want = newest + 1;
  let count = want;
  for (let i = 0; i < want; i++) {
    if (!ring.has(newest - i)) {
      count = i;
      break;
    }
  }
  const first = newest - count + 1;
  for (let i = 0; i < count; i++) ring.copyTo(first + i, out, i * PACKED_INPUT_BYTES);
  return count;
}
