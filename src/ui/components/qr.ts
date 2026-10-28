/**
 * `mn-qr` (plan §1.3): a QR code drawn in SVG, made here (no dependency): a lobby's join link on a
 * TV, which has no share sheet (screens/lobby.ts), later PR 14's sign-in with the phone. Byte mode,
 * versions 1 to 10 (up to 213 bytes at level M: a link is about 35), error correction M, the mask
 * with the lowest penalty of the eight (ISO/IEC 18004 §7.8.3). The encoding follows the standard
 * step by step (data bits, Reed-Solomon over GF(256) with 0x11D, blocks interleaved, function
 * patterns, zig-zag placement, format and version words); tests/qr.test.mjs checks it against the
 * standard's published values and decodes the symbol back. qrMatrix is pure; qrSvg builds the element
 * on call.
 */

export type QrLevel = 'L' | 'M';

/** Error correction codewords per block and blocks, by level and version (index 0 unused). */
const ECC_PER_BLOCK: Record<QrLevel, readonly number[]> = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
};
const BLOCKS: Record<QrLevel, readonly number[]> = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
};
/** The 2-bit level field of the format word (L 01, M 00). */
const LEVEL_BITS: Record<QrLevel, number> = { L: 1, M: 0 };
export const QR_MAX_VERSION = 10;

// ---- Reed-Solomon over GF(2^8), the field of x^8 + x^4 + x^3 + x^2 + 1 -----------------------

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

/** The generator polynomial of `degree` (its coefficients after the leading 1, highest first). */
function rsDivisor(degree: number): number[] {
  const out = new Array<number>(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < out.length; j++) {
      out[j] = gfMul(out[j], root);
      if (j + 1 < out.length) out[j] ^= out[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return out;
}

/** The `ecLen` error correction codewords of `data`. */
export function rsEncode(data: readonly number[], ecLen: number): number[] {
  const div = rsDivisor(ecLen);
  const out = new Array<number>(ecLen).fill(0);
  for (const b of data) {
    const factor = b ^ (out.shift() as number);
    out.push(0);
    for (let i = 0; i < out.length; i++) out[i] ^= gfMul(div[i], factor);
  }
  return out;
}

// ---- the words around the data --------------------------------------------------------------

/** The 15-bit format word of `level` and `mask` (BCH(15,5), masked with 101010000010010). */
export function formatBits(level: QrLevel, mask: number): number {
  const data = (LEVEL_BITS[level] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** The 18-bit version word (versions 7 and up; BCH(18,6)). */
export function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

const size = (version: number): number => version * 4 + 17;

function rawDataModules(version: number): number {
  let n = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (version >= 7) n -= 36;
  }
  return n;
}

function dataCodewords(version: number, level: QrLevel): number {
  return Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK[level][version] * BLOCKS[level][version];
}

/** The centres of the alignment patterns on each axis. */
export function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const n = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size(version) - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

/** The smallest version that holds `bytes` bytes at `level`, or null when none up to QR_MAX_VERSION does. */
export function qrVersionFor(bytes: number, level: QrLevel = 'M'): number | null {
  for (let v = 1; v <= QR_MAX_VERSION; v++) {
    const countBits = v <= 9 ? 8 : 16;
    if (4 + countBits + bytes * 8 <= dataCodewords(v, level) * 8) return v;
  }
  return null;
}

/** The data and error correction codewords of `bytes`, interleaved as the symbol carries them. */
function codewords(bytes: Uint8Array, version: number, level: QrLevel): number[] {
  const cap = dataCodewords(version, level) * 8;
  const bits: number[] = [];
  const put = (v: number, n: number): void => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  put(0b0100, 4); // byte mode
  put(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap - bits.length)); // terminator
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  const nBlocks = BLOCKS[level][version];
  const ecLen = ECC_PER_BLOCK[level][version];
  const raw = Math.floor(rawDataModules(version) / 8);
  const nShort = nBlocks - (raw % nBlocks);
  const shortLen = Math.floor(raw / nBlocks);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < nBlocks; i++) {
    const dat = data.slice(k, k + shortLen - ecLen + (i < nShort ? 0 : 1));
    k += dat.length;
    const ecc = rsEncode(dat, ecLen);
    if (i < nShort) dat.push(0); // a gap, skipped below
    blocks.push(dat.concat(ecc));
  }
  const out: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < blocks.length; j++) if (i !== shortLen - ecLen || j >= nShort) out.push(blocks[j][i]);
  }
  return out;
}

const MASKS: ReadonlyArray<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** One symbol: its modules (true = dark) by row, and whether each is a function pattern. */
class QrSymbol {
  readonly version: number;
  readonly n: number;
  readonly dark: boolean[][];
  readonly fn: boolean[][];

  constructor(version: number) {
    this.version = version;
    this.n = size(version);
    this.dark = Array.from({ length: this.n }, () => new Array<boolean>(this.n).fill(false));
    this.fn = Array.from({ length: this.n }, () => new Array<boolean>(this.n).fill(false));
  }

  set(x: number, y: number, dark: boolean): void {
    this.dark[y][x] = dark;
    this.fn[y][x] = true;
  }

  drawFunctions(level: QrLevel): void {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= n || y >= n) continue;
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          this.set(x, y, d !== 2 && d !== 4);
        }
      }
    }
    const pos = alignmentPositions(this.version);
    const last = pos.length - 1;
    for (let i = 0; i <= last; i++) {
      for (let j = 0; j <= last; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
    this.drawFormat(level, 0); // reserved now, written with the mask
    if (this.version >= 7) {
      const bits = versionBits(this.version);
      for (let i = 0; i < 18; i++) {
        const on = ((bits >>> i) & 1) === 1;
        const a = n - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.set(a, b, on);
        this.set(b, a, on);
      }
    }
  }

  drawFormat(level: QrLevel, mask: number): void {
    const n = this.n;
    const bits = formatBits(level, mask);
    const bit = (i: number): boolean => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(n - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, n - 15 + i, bit(i));
    this.set(8, n - 8, true); // the dark module
  }

  drawData(words: readonly number[]): void {
    const n = this.n;
    let i = 0;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let v = 0; v < n; v++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const up = ((right + 1) & 2) === 0;
          const y = up ? n - 1 - v : v;
          if (this.fn[y][x] || i >= words.length * 8) continue;
          this.dark[y][x] = ((words[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }

  /** XOR mask `m` over the data modules (twice undoes it). */
  mask(m: number): void {
    const f = MASKS[m];
    for (let y = 0; y < this.n; y++) for (let x = 0; x < this.n; x++) if (!this.fn[y][x] && f(x, y)) this.dark[y][x] = !this.dark[y][x];
  }

  /** The standard's penalty (N1 3, N2 3, N3 40, N4 10): runs, 2 x 2 blocks, finder-like runs, balance. */
  penalty(): number {
    const n = this.n;
    let score = 0;
    const line = (get: (i: number) => boolean): void => {
      let color = false;
      let run = 0;
      const hist = [0, 0, 0, 0, 0, 0, 0];
      const add = (len: number): void => {
        if (hist[0] === 0) len += n; // the light border before the first run
        hist.pop();
        hist.unshift(len);
      };
      const finders = (): number => {
        const k = hist[1];
        const core = k > 0 && hist[2] === k && hist[3] === k * 3 && hist[4] === k && hist[5] === k;
        return (core && hist[0] >= k * 4 && hist[6] >= k ? 1 : 0) + (core && hist[6] >= k * 4 && hist[0] >= k ? 1 : 0);
      };
      for (let i = 0; i < n; i++) {
        if (get(i) === color) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score++;
        } else {
          add(run);
          if (!color) score += finders() * 40;
          color = get(i);
          run = 1;
        }
      }
      if (color) {
        add(run);
        run = 0;
      }
      add(run + n);
      score += finders() * 40;
    };
    for (let y = 0; y < n; y++) line((x) => this.dark[y][x]);
    for (let x = 0; x < n; x++) line((y) => this.dark[y][x]);
    let darkCount = 0;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (this.dark[y][x]) darkCount++;
        if (x < n - 1 && y < n - 1) {
          const c = this.dark[y][x];
          if (c === this.dark[y][x + 1] && c === this.dark[y + 1][x] && c === this.dark[y + 1][x + 1]) score += 3;
        }
      }
    }
    const total = n * n;
    score += (Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1) * 10;
    return score;
  }
}

export interface QrMatrix {
  version: number;
  mask: number;
  /** Rows of modules, true = dark (no quiet zone: draw 4 light modules around it). */
  modules: boolean[][];
}

/** The QR symbol of `text` (UTF-8, byte mode); null when it does not fit version QR_MAX_VERSION. Pure. */
export function qrMatrix(text: string, level: QrLevel = 'M', forceMask: number | null = null): QrMatrix | null {
  const bytes = new TextEncoder().encode(text);
  const version = qrVersionFor(bytes.length, level);
  if (version === null) return null;
  const words = codewords(bytes, version, level);
  const sym = new QrSymbol(version);
  sym.drawFunctions(level);
  sym.drawData(words);
  let best = forceMask ?? 0;
  if (forceMask === null) {
    let low = Infinity;
    for (let m = 0; m < 8; m++) {
      sym.mask(m);
      sym.drawFormat(level, m);
      const p = sym.penalty();
      if (p < low) {
        low = p;
        best = m;
      }
      sym.mask(m);
    }
  }
  sym.mask(best);
  sym.drawFormat(level, best);
  return { version, mask: best, modules: sym.dark };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The QR of `text` as an SVG (one path, `currentColor` on a light square; 4 modules of quiet zone), `label` its accessible name. */
export function qrSvg(text: string, label: string): SVGSVGElement | null {
  const q = qrMatrix(text);
  if (q === null) return null;
  const n = q.modules.length;
  const full = n + 8;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.modules[y][x]) d += `M${x + 4} ${y + 4}h1v1h-1z`;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${full} ${full}`);
  svg.setAttribute('class', 'mn-qr');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  svg.setAttribute('shape-rendering', 'crispEdges');
  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('width', String(full));
  bg.setAttribute('height', String(full));
  bg.setAttribute('class', 'mn-qr-bg');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('class', 'mn-qr-fg');
  svg.append(bg, path);
  return svg;
}
