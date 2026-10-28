// The in-house QR (src/ui/components/qr.ts, plan PR 12: a TV shares a lobby's link as a QR) against
// the standard's published values: the Reed-Solomon codewords of the well-known "HELLO WORLD"
// 1-M example, the format words of levels L and M (ISO/IEC 18004 table C.1), the version word of
// version 7 (table D.1), the alignment centres (table E.1); then each symbol is read back by a reader
// written here from the standard (function patterns, unmasking, the zig-zag, the block
// interleaving, Reed-Solomon syndromes, byte mode) and must give the text again.
// Run: node --test tests/qr.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const Q = await import('../src/ui/components/qr.ts');

test('Reed-Solomon: the "HELLO WORLD" 1-M data codewords give the published 10 error correction codewords', () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(Q.rsEncode(data, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test('format words of levels L and M, every mask, as the standard lists them', () => {
  const M = ['101010000010010', '101000100100101', '101111001111100', '101101101001011', '100010111111001', '100000011001110', '100111110010111', '100101010100000'];
  const L = ['111011111000100', '111001011110011', '111110110101010', '111100010011101', '110011000101111', '110001100011000', '110110001000001', '110100101110110'];
  for (let m = 0; m < 8; m++) {
    assert.equal(Q.formatBits('M', m).toString(2).padStart(15, '0'), M[m], `M mask ${m}`);
    assert.equal(Q.formatBits('L', m).toString(2).padStart(15, '0'), L[m], `L mask ${m}`);
  }
});

test('the version word of version 7 and the alignment centres', () => {
  assert.equal(Q.versionBits(7).toString(2).padStart(18, '0'), '000111110010010100');
  assert.deepEqual(Q.alignmentPositions(1), []);
  assert.deepEqual(Q.alignmentPositions(2), [6, 18]);
  assert.deepEqual(Q.alignmentPositions(3), [6, 22]);
  assert.deepEqual(Q.alignmentPositions(7), [6, 22, 38]);
  assert.deepEqual(Q.alignmentPositions(10), [6, 28, 50]);
});

// ---- a reader, from the standard -----------------------------------------------------------------

const EC = { M: { ecc: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26], blocks: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5] } };
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
const MASK = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];
const FORMAT_M = ['101010000010010', '101000100100101', '101111001111100', '101101101001011', '100010111111001', '100000011001110', '100111110010111', '100101010100000'];

/** Modules no data goes in: finders with separators and format areas, timing, alignment, version areas, the dark module. */
function reserved(v) {
  const n = v * 4 + 17;
  const r = Array.from({ length: n }, () => new Array(n).fill(false));
  const box = (x0, y0, w, h) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) r[y][x] = true;
  };
  box(0, 0, 9, 9);
  box(n - 8, 0, 8, 9);
  box(0, n - 8, 9, 8);
  for (let i = 0; i < n; i++) r[6][i] = r[i][6] = true;
  const a = ALIGN[v];
  for (const cx of a) for (const cy of a) {
    if ((cx === 6 && cy === 6) || (cx === 6 && cy === a.at(-1)) || (cx === a.at(-1) && cy === 6)) continue;
    box(cx - 2, cy - 2, 5, 5);
  }
  if (v >= 7) {
    box(n - 11, 0, 3, 6);
    box(0, n - 11, 6, 3);
  }
  return r;
}

// GF(256) with 0x11D, for the syndromes.
const EXP = new Array(512);
const LOG = new Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
/** A block (data then error correction, highest power first) is a codeword: zero at alpha^0 .. alpha^(ecLen-1). */
function syndromesZero(block, ecLen) {
  for (let i = 0; i < ecLen; i++) {
    let s = 0;
    for (const c of block) s = mul(s, EXP[i]) ^ c;
    if (s !== 0) return false;
  }
  return true;
}

function read(q) {
  const m = q.modules;
  const n = m.length;
  const v = (n - 17) / 4;
  assert.equal(v, q.version);
  // Finder patterns where they belong, and the dark module.
  for (const [x0, y0] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
    for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
      const d = Math.max(Math.abs(x - 3), Math.abs(y - 3));
      assert.equal(m[y0 + y][x0 + x], d !== 2, `finder at ${x0},${y0}`);
    }
  }
  assert.equal(m[n - 8][8], true, 'the dark module');
  // The format word (first copy, around the top-left finder), as the table lists it, gives the mask.
  let f = '';
  for (const [x, y] of [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]]) f = (m[y][x] ? '1' : '0') + f;
  const mask = FORMAT_M.indexOf(f);
  assert.ok(mask >= 0, `a level M format word (${f})`);
  assert.equal(mask, q.mask);
  // The second copy says the same.
  let f2 = '';
  for (let i = 0; i < 8; i++) f2 = (m[8][n - 1 - i] ? '1' : '0') + f2;
  for (let i = 8; i < 15; i++) f2 = (m[n - 15 + i][8] ? '1' : '0') + f2;
  assert.equal(f2, f, 'both format copies agree');
  if (v >= 7) {
    let w = '';
    for (let i = 17; i >= 0; i--) w += m[Math.floor(i / 3)][n - 11 + (i % 3)] ? '1' : '0';
    assert.equal(parseInt(w, 2), Q.versionBits(v), 'the version word');
  }
  // The zig-zag, unmasked.
  const res = reserved(v);
  const bits = [];
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let k = 0; k < n; k++) for (let j = 0; j < 2; j++) {
      const x = right - j;
      const y = ((right + 1) & 2) === 0 ? n - 1 - k : k;
      if (!res[y][x]) bits.push(m[y][x] !== MASK[mask](x, y) ? 1 : 0);
    }
  }
  const words = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((a, b) => a * 2 + b, 0));
  // De-interleave: the short blocks first, each with one data codeword less.
  const nb = EC.M.blocks[v];
  const ecLen = EC.M.ecc[v];
  const total = words.length;
  const shortLen = Math.floor(total / nb);
  const nShort = nb - (total % nb);
  const dataLens = Array.from({ length: nb }, (_, i) => shortLen - ecLen + (i < nShort ? 0 : 1));
  const blocks = dataLens.map(() => []);
  let k = 0;
  for (let i = 0; i < Math.max(...dataLens); i++) for (let b = 0; b < nb; b++) if (i < dataLens[b]) blocks[b].push(words[k++]);
  for (let i = 0; i < ecLen; i++) for (let b = 0; b < nb; b++) blocks[b].push(words[k++]);
  for (const b of blocks) assert.ok(syndromesZero(b, ecLen), 'every block is a Reed-Solomon codeword');
  const data = blocks.flatMap((b, i) => b.slice(0, dataLens[i]));
  // Byte mode: 0100, the count, the bytes.
  const dbits = data.flatMap((w) => Array.from({ length: 8 }, (_, i) => (w >> (7 - i)) & 1));
  const take = (from, len) => dbits.slice(from, from + len).reduce((a, b) => a * 2 + b, 0);
  assert.equal(take(0, 4), 0b0100, 'byte mode');
  const countBits = v <= 9 ? 8 : 16;
  const len = take(4, countBits);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = take(4 + countBits + i * 8, 8);
  return new TextDecoder().decode(out);
}

test('a lobby link (version 3, one block) reads back; so do a two-block, a four-block and a version 7 symbol, with every mask', () => {
  const link = 'https://turbo-gol.com/#sala=ABC234';
  const q = Q.qrMatrix(link);
  assert.equal(q.version, 3);
  assert.equal(read(q), link);
  assert.equal(read(Q.qrMatrix('http://127.0.0.1:5290/#sala=ZZ9X2K')), 'http://127.0.0.1:5290/#sala=ZZ9X2K');
  const long = 'https://turbo-gol.com/#sala=ABC234&' + 'x'.repeat(40); // 76 bytes: version 5, two blocks
  assert.equal(Q.qrMatrix(long).version, 5);
  assert.equal(read(Q.qrMatrix(long)), long);
  const v6 = 'ñandú '.repeat(12); // 96 UTF-8 bytes: version 6, four blocks
  assert.equal(Q.qrMatrix(v6).version, 6);
  assert.equal(read(Q.qrMatrix(v6)), v6);
  const v7 = 'y'.repeat(120);
  assert.equal(Q.qrMatrix(v7).version, 7);
  assert.equal(read(Q.qrMatrix(v7)), v7);
  for (let m = 0; m < 8; m++) assert.equal(read(Q.qrMatrix(link, 'M', m)), link, `mask ${m}`);
  assert.equal(Q.qrMatrix('z'.repeat(300)), null, 'past version 10: none');
});
