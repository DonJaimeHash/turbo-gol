/**
 * InputStore: one ring of packed inputs (6 int8 per tick, types.ts packControls) per slot, keyed by
 * tick, for the P2P rollback engine (docs/online/PHASE2.md). The label array `ticks` is the "known"
 * map: a cell is known for tick t when its label equals t; otherwise it holds whatever older tick
 * lived there. Capacity INPUT_STORE_TICKS ticks per slot (~2.1 s at 120 Hz), newer ticks overwrite
 * older ones at the same index. Allocation-free after construction.
 */
import { PACKED_INPUT_BYTES } from '../../sim/types';

export const INPUT_STORE_TICKS = 256;

export class InputStore {
  readonly numSlots: number;
  readonly capacity: number;
  /** numSlots x capacity x 6 int8; the cell of (slot, tick) starts at offsetOf(slot, tick). */
  readonly data: Int8Array;
  /** numSlots x capacity labels: the tick stored in each cell, -1 = never written. */
  readonly ticks: Int32Array;
  private readonly mask: number;

  constructor(numSlots: number, capacity: number = INPUT_STORE_TICKS) {
    if (numSlots < 1) throw new Error(`InputStore: numSlots ${numSlots}`);
    if (capacity < 2 || (capacity & (capacity - 1)) !== 0) throw new Error(`InputStore: capacity ${capacity} must be a power of two`);
    this.numSlots = numSlots;
    this.capacity = capacity;
    this.mask = capacity - 1;
    this.data = new Int8Array(numSlots * capacity * PACKED_INPUT_BYTES);
    this.ticks = new Int32Array(numSlots * capacity).fill(-1);
  }

  private cell(slot: number, tick: number): number {
    return slot * this.capacity + (tick & this.mask);
  }

  /** True when the input of `tick` for `slot` is stored (and not overwritten by a newer tick). */
  has(slot: number, tick: number): boolean {
    return tick >= 0 && this.ticks[this.cell(slot, tick)] === tick;
  }

  /** Byte offset of (slot, tick) inside `data`; only meaningful when has(slot, tick). */
  offsetOf(slot: number, tick: number): number {
    return this.cell(slot, tick) * PACKED_INPUT_BYTES;
  }

  /** Store the 6 bytes at src[off..off+6) as the input of (slot, tick) and mark it known. */
  set(slot: number, tick: number, src: Int8Array, off: number): void {
    const c = this.cell(slot, tick);
    const base = c * PACKED_INPUT_BYTES;
    const d = this.data;
    for (let i = 0; i < PACKED_INPUT_BYTES; i++) d[base + i] = src[off + i];
    this.ticks[c] = tick;
  }

  /** Copy the input of (slot, tick) to dst[off..off+6); false (dst untouched) when unknown. */
  copyTo(slot: number, tick: number, dst: Int8Array, off: number): boolean {
    const c = this.cell(slot, tick);
    if (tick < 0 || this.ticks[c] !== tick) return false;
    const base = c * PACKED_INPUT_BYTES;
    const d = this.data;
    for (let i = 0; i < PACKED_INPUT_BYTES; i++) dst[off + i] = d[base + i];
    return true;
  }

  /** True when (slot, tick) is known and equals the 6 bytes at src[off..]. */
  equals(slot: number, tick: number, src: Int8Array, off: number): boolean {
    const c = this.cell(slot, tick);
    if (tick < 0 || this.ticks[c] !== tick) return false;
    const base = c * PACKED_INPUT_BYTES;
    const d = this.data;
    for (let i = 0; i < PACKED_INPUT_BYTES; i++) if (d[base + i] !== src[off + i]) return false;
    return true;
  }

  /** Mark (slot, tick) unknown. */
  forget(slot: number, tick: number): void {
    const c = this.cell(slot, tick);
    if (this.ticks[c] === tick) this.ticks[c] = -1;
  }

  /** Mark every stored tick of `slot` below `tick` unknown (resync). */
  forgetBelow(slot: number, tick: number): void {
    const base = slot * this.capacity;
    const t = this.ticks;
    for (let i = 0; i < this.capacity; i++) if (t[base + i] >= 0 && t[base + i] < tick) t[base + i] = -1;
  }

  clearSlot(slot: number): void {
    this.ticks.fill(-1, slot * this.capacity, (slot + 1) * this.capacity);
  }

  clear(): void {
    this.ticks.fill(-1);
  }
}
