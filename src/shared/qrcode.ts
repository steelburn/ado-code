/**
 * Vendored QR encoder (R-P1-03) — MIT, nayuki-qrcodegen style, written for this
 * repo so the extension keeps its **zero runtime dependency** promise.
 *
 * Scope: byte mode, ECC levels L and M, versions 1–10 (up to 213 bytes at L /
 * 194 at M) — comfortably more than a console URL needs
 * (`https://<tunnel>.trycloudflare.com/?t=<43 chars>` ≈ 66 bytes).
 *
 * Pure computation, no `vscode`, no DOM, no Buffer-formatting: `toSvg()` returns
 * a self-contained SVG string so the QR panel needs neither a canvas nor a
 * renderer library.
 */

/** Error-correction level. */
export type QrEcc = 'L' | 'M';

export interface QrMatrix {
  version: number;
  size: number;
  mask: number;
  ecc: QrEcc;
  /** `modules[y][x] === true` means a dark module. */
  modules: boolean[][];
}

export interface QrSvgOptions {
  ecc?: QrEcc;
  /** Pixels per module. */
  scale?: number;
  /** Quiet-zone width in modules (spec minimum is 4). */
  border?: number;
  dark?: string;
  light?: string;
  /** Render no background rect (transparent quiet zone). */
  transparent?: boolean;
}

const MIN_VERSION = 1;
const MAX_VERSION = 10;

/**
 * ECC codewords per block, indexed by version (index 0 unused).
 * ISO/IEC 18004 Table 9 — Extended Channel Interpretation not used.
 */
const ECC_CODEWORDS_PER_BLOCK: Record<QrEcc, readonly number[]> = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
};

/** Number of error-correction blocks, indexed by version (index 0 unused). */
const NUM_ERROR_CORRECTION_BLOCKS: Record<QrEcc, readonly number[]> = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
};

/** Alignment-pattern centre coordinates, versions 2–10. */
const ALIGNMENT_POSITIONS: readonly (readonly number[])[] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

/** Format-info bits per level: L=1, M=0, Q=3, H=2 (only L/M are offered). */
const ECC_FORMAT_BITS: Record<QrEcc, number> = { L: 1, M: 0 };

/** Total number of data+ECC modules available in `version` (excluding function patterns). */
export function getNumRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) {
      result -= 36;
    }
  }
  return result;
}

/** Total codewords (data + ECC) for a version. */
export function getNumCodewords(version: number): number {
  return Math.floor(getNumRawDataModules(version) / 8);
}

/** Data codewords available for a version + ECC level. */
export function getNumDataCodewords(version: number, ecc: QrEcc): number {
  return (
    getNumCodewords(version) -
    ECC_CODEWORDS_PER_BLOCK[ecc][version]! * NUM_ERROR_CORRECTION_BLOCKS[ecc][version]!
  );
}

/** Smallest version that fits `byteLength` bytes in byte mode. */
export function pickVersion(byteLength: number, ecc: QrEcc): number {
  for (let version = MIN_VERSION; version <= MAX_VERSION; version++) {
    const capacityBits = getNumDataCodewords(version, ecc) * 8;
    // 4 mode bits + character-count indicator + payload.
    const countBits = version < 10 ? 8 : 16;
    if (4 + countBits + byteLength * 8 <= capacityBits) {
      return version;
    }
  }
  throw new Error(
    `qrcode: payload of ${byteLength} bytes does not fit version ${MAX_VERSION} at ECC ${ecc}`
  );
}

/**
 * Encode `text` (UTF-8, byte mode) into a module matrix with the mask that
 * scores best under the standard penalty rules.
 */
export function encodeQr(text: string, options?: { ecc?: QrEcc }): QrMatrix {
  if (typeof text !== 'string') {
    throw new TypeError('qrcode: text must be a string');
  }
  if (text.length === 0) {
    throw new Error('qrcode: empty input');
  }
  const ecc: QrEcc = options?.ecc ?? 'M';
  if (ecc !== 'L' && ecc !== 'M') {
    throw new Error(`qrcode: unsupported ECC level ${String(ecc)}`);
  }

  const dataBytes = utf8Bytes(text);
  const version = pickVersion(dataBytes.length, ecc);
  const size = version * 4 + 17;

  // ── Segment + terminator + padding → data codewords ──────────────────
  const capacityBits = getNumDataCodewords(version, ecc) * 8;
  const bits: number[] = [];
  appendBits(bits, 0b0100, 4); // byte mode
  appendBits(bits, dataBytes.length, version < 10 ? 8 : 16);
  for (const byte of dataBytes) {
    appendBits(bits, byte, 8);
  }
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length)); // terminator
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8); // pad to a byte boundary
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) {
    appendBits(bits, pad, 8);
  }
  const dataCodewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) {
      byte = (byte << 1) | (bits[i + j] ?? 0);
    }
    dataCodewords.push(byte);
  }

  // ── Paint ────────────────────────────────────────────────────────────
  const modules: boolean[][] = [];
  const isFunction: boolean[][] = [];
  for (let y = 0; y < size; y++) {
    modules.push(new Array<boolean>(size).fill(false));
    isFunction.push(new Array<boolean>(size).fill(false));
  }

  const setFunction = (x: number, y: number, dark: boolean): void => {
    if (x < 0 || y < 0 || x >= size || y >= size) {
      return;
    }
    modules[y]![x] = dark;
    isFunction[y]![x] = true;
  };

  // Timing patterns.
  for (let i = 0; i < size; i++) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }

  // Finder patterns (centre-based so the 4-module separators come along).
  const drawFinder = (cx: number, cy: number): void => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        setFunction(cx + dx, cy + dy, dist !== 2 && dist !== 4);
      }
    }
  };
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);

  // Alignment patterns (all centre pairs except the three finder corners).
  const align = ALIGNMENT_POSITIONS[version]!;
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) {
        continue;
      }
      const cx = align[i]!;
      const cy = align[j]!;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  const drawFormatBits = (mask: number): void => {
    const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) {
      rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    }
    const format = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number): boolean => ((format >>> i) & 1) !== 0;

    // Copy 1 — around the top-left finder.
    for (let i = 0; i <= 5; i++) setFunction(8, i, bit(i));
    setFunction(8, 7, bit(6));
    setFunction(8, 8, bit(7));
    setFunction(7, 8, bit(8));
    for (let i = 9; i < 15; i++) setFunction(14 - i, 8, bit(i));

    // Copy 2 — split between the other two finders.
    for (let i = 0; i < 8; i++) setFunction(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) setFunction(8, size - 15 + i, bit(i));

    setFunction(8, size - 8, true); // the always-dark module
  };

  drawFormatBits(0); // provisional, redrawn once the mask is chosen

  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) {
      rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    }
    const versionBits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((versionBits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunction(a, b, dark);
      setFunction(b, a, dark);
    }
  }

  // ── Codewords → modules (zig-zag) ────────────────────────────────────
  const codewords = addEccAndInterleave(dataCodewords, version, ecc);
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) {
      right = 5; // skip the vertical timing column
    }
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y]![x] && bitIndex < codewords.length * 8) {
          modules[y]![x] = ((codewords[bitIndex >>> 3]! >>> (7 - (bitIndex & 7))) & 1) !== 0;
          bitIndex++;
        }
      }
    }
  }

  // ── Mask selection ───────────────────────────────────────────────────
  const applyMask = (mask: number): void => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (isFunction[y]![x]) {
          continue;
        }
        let invert: boolean;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (invert) {
          modules[y]![x] = !modules[y]![x];
        }
      }
    }
  };

  let bestMask = 0;
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormatBits(mask);
    const penalty = getPenaltyScore(modules, size);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
    }
    applyMask(mask); // undo (XOR is its own inverse)
  }
  applyMask(bestMask);
  drawFormatBits(bestMask);

  return { version, size, mask: bestMask, ecc, modules };
}

/** Render `text` as a standalone SVG string (quiet zone included). */
export function toSvg(text: string, options?: QrSvgOptions): string {
  const matrix = encodeQr(text, { ecc: options?.ecc });
  const scale = options?.scale ?? 8;
  const border = options?.border ?? 4;
  const dark = options?.dark ?? '#000000';
  const light = options?.light ?? '#ffffff';
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error('qrcode: scale must be a positive number');
  }
  if (!Number.isFinite(border) || border < 0) {
    throw new Error('qrcode: border must be >= 0');
  }

  const dim = (matrix.size + border * 2) * scale;
  const parts: string[] = [];
  // One path keeps the markup small and prevents hairline seams between modules.
  for (let y = 0; y < matrix.size; y++) {
    let x = 0;
    while (x < matrix.size) {
      if (!matrix.modules[y]![x]) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < matrix.size && matrix.modules[y]![x + run]) {
        run++;
      }
      const px = (x + border) * scale;
      const py = (y + border) * scale;
      parts.push(`M${px} ${py}h${run * scale}v${scale}h-${run * scale}z`);
      x += run;
    }
  }

  const background =
    options?.transparent === true
      ? ''
      : `<rect width="${dim}" height="${dim}" fill="${escapeAttr(light)}"/>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${dim}" height="${dim}" ` +
    `viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img">` +
    background +
    `<path d="${parts.join('')}" fill="${escapeAttr(dark)}"/>` +
    `</svg>`
  );
}

// ── internals ──────────────────────────────────────────────────────────

function appendBits(target: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i--) {
    target.push((value >>> i) & 1);
  }
}

function utf8Bytes(text: string): number[] {
  const bytes = Buffer.from(text, 'utf8');
  const out: number[] = [];
  for (const byte of bytes) {
    out.push(byte);
  }
  return out;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

/** GF(2^8) multiply modulo the QR polynomial 0x11D. */
function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** Reed–Solomon generator polynomial coefficients (degree `degree`). */
export function reedSolomonComputeDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < degree) {
        result[j] ^= result[j + 1]!;
      }
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** Remainder of `data` divided by the generator polynomial. */
export function reedSolomonComputeRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    for (let i = 0; i < divisor.length; i++) {
      result[i] ^= gfMultiply(divisor[i]!, factor);
    }
  }
  return result;
}

/** Split into blocks, append ECC per block, then interleave (ISO 18004 §7.6). */
function addEccAndInterleave(data: readonly number[], version: number, ecc: QrEcc): number[] {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecc][version]!;
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecc][version]!;
  const rawCodewords = getNumCodewords(version);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = reedSolomonComputeDivisor(blockEccLen);

  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dataLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = data.slice(k, k + dataLen);
    k += dataLen;
    const block = dat.slice();
    if (i < numShortBlocks) {
      block.push(0); // placeholder so every block has the same length
    }
    blocks.push(block.concat(reedSolomonComputeRemainder(dat, divisor)));
  }

  const result: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      // The padding placeholder is skipped when interleaving the data half.
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) {
        result.push(blocks[j]![i]!);
      }
    }
  }
  return result;
}

/** ISO/IEC 18004 §7.8.3 penalty rules N1–N4. */
function getPenaltyScore(modules: boolean[][], size: number): number {
  let score = 0;

  // N1 — runs of five or more same-coloured modules (rows then columns).
  for (const horizontal of [true, false]) {
    for (let a = 0; a < size; a++) {
      let runColor = false;
      let runLength = 0;
      for (let b = 0; b < size; b++) {
        const color = horizontal ? modules[a]![b]! : modules[b]![a]!;
        if (b === 0) {
          runColor = color;
          runLength = 1;
        } else if (color === runColor) {
          runLength++;
          if (runLength === 5) {
            score += 3;
          } else if (runLength > 5) {
            score += 1;
          }
        } else {
          runColor = color;
          runLength = 1;
        }
      }
    }
  }

  // N2 — 2×2 blocks of one colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const color = modules[y]![x];
      if (
        color === modules[y]![x + 1] &&
        color === modules[y + 1]![x] &&
        color === modules[y + 1]![x + 1]
      ) {
        score += 3;
      }
    }
  }

  // N3 — finder-like 1:1:3:1:1 patterns with a 4-module light margin.
  const patternA = [true, false, true, true, true, false, true, false, false, false, false];
  const patternB = [false, false, false, false, true, false, true, true, true, false, true];
  for (const horizontal of [true, false]) {
    for (let a = 0; a < size; a++) {
      for (let b = 0; b + 11 <= size; b++) {
        let matchA = true;
        let matchB = true;
        for (let k = 0; k < 11; k++) {
          const color = horizontal ? modules[a]![b + k]! : modules[b + k]![a]!;
          if (color !== patternA[k]) matchA = false;
          if (color !== patternB[k]) matchB = false;
        }
        if (matchA) score += 40;
        if (matchB) score += 40;
      }
    }
  }

  // N4 — deviation from a 50 % dark ratio.
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y]![x]) dark++;
    }
  }
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  score += Math.max(0, k) * 10;

  return score;
}
