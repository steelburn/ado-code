/**
 * Byte-level image fixtures for the `imageSize` / `imageAssets` suites.
 *
 * These are hand-assembled *headers*, not decodable images: the sniffer only
 * ever reads the signature and the dimension fields, so building the exact
 * bytes lets a test pin one format quirk at a time (a WebP VP8L packed
 * dimension, a top-down BMP, a JPEG with several skipped segments) without
 * checking binary blobs into the repo.
 */

export function writeU16LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
}

export function writeU32LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

export function writeU24LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
}

export function writeI32LE(bytes: Uint8Array, offset: number, value: number): void {
  writeU32LE(bytes, offset, value < 0 ? 0x100000000 + value : value);
}

export function writeU32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

/** PNG signature + IHDR. 33 bytes; the CRC is omitted because nothing decodes it. */
export function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8); // IHDR length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
  writeU32BE(bytes, 16, width);
  writeU32BE(bytes, 20, height);
  bytes.set([0x08, 0x06, 0x00, 0x00, 0x00], 24); // depth, colour, compression, filter, interlace
  return bytes;
}

/** PNG truncated before the height field — a corrupt file must sniff to null, not throw. */
export function truncatedPngBytes(): Uint8Array {
  return pngBytes(640, 480).subarray(0, 12);
}

/** GIF87a/89a logical screen descriptor. */
export function gifBytes(width: number, height: number, version: '87a' | '89a' = '89a'): Uint8Array {
  const bytes = new Uint8Array(19);
  bytes.set([0x47, 0x49, 0x46, 0x38, ...(version === '89a' ? [0x39, 0x61] : [0x37, 0x61])], 0);
  writeU16LE(bytes, 6, width);
  writeU16LE(bytes, 8, height);
  return bytes;
}

/**
 * JPEG: SOI, an APP0 segment that must be skipped by its length field, then SOF0.
 * `padSegments` inserts extra APPn segments to exercise the marker walk.
 */
export function jpegBytes(width: number, height: number, padSegments = 0): Uint8Array {
  const bytes: number[] = [0xff, 0xd8];
  for (let i = 0; i < padSegments; i++) {
    bytes.push(0xff, 0xe1, 0x00, 0x10);
    for (let p = 0; p < 14; p++) {
      bytes.push(0x00);
    }
  }
  bytes.push(0xff, 0xe0, 0x00, 0x10); // APP0, length 16
  for (let p = 0; p < 14; p++) {
    bytes.push(0x00);
  }
  bytes.push(0xff, 0xc0, 0x00, 0x11, 0x08); // SOF0, length 17, precision 8
  bytes.push((height >> 8) & 0xff, height & 0xff);
  bytes.push((width >> 8) & 0xff, width & 0xff);
  bytes.push(0x03); // 3 components
  for (let p = 0; p < 9; p++) {
    bytes.push(0x00);
  }
  bytes.push(0xff, 0xd9); // EOI
  return Uint8Array.from(bytes);
}

function webpHeader(chunkFourCC: number[], payloadSize: number): Uint8Array {
  const bytes = new Uint8Array(20 + payloadSize);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // 'RIFF'
  writeU32LE(bytes, 4, 4 + 8 + payloadSize);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // 'WEBP'
  bytes.set(chunkFourCC, 12);
  writeU32LE(bytes, 16, payloadSize);
  return bytes;
}

/** Extended (alpha/animated) WebP: dimensions stored as 24-bit value minus one. */
export function webpVp8xBytes(width: number, height: number): Uint8Array {
  const bytes = webpHeader([0x56, 0x50, 0x38, 0x58], 10); // 'VP8X'
  writeU24LE(bytes, 24, width - 1);
  writeU24LE(bytes, 27, height - 1);
  return bytes;
}

/** Lossless WebP: 0x2F signature then 14-bit width-1 / height-1 packed little-endian. */
export function webpVp8lBytes(width: number, height: number): Uint8Array {
  const bytes = webpHeader([0x56, 0x50, 0x38, 0x4c], 5); // 'VP8L'
  bytes[20] = 0x2f;
  writeU32LE(bytes, 21, (((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)) >>> 0);
  return bytes;
}

/** BMP with a signed height, so top-down bitmaps report a positive dimension. */
export function bmpBytes(width: number, height: number, topDown = false): Uint8Array {
  const bytes = new Uint8Array(54);
  bytes.set([0x42, 0x4d], 0); // 'BM'
  writeU32LE(bytes, 2, 54);
  writeI32LE(bytes, 18, width);
  writeI32LE(bytes, 22, topDown ? -height : height);
  return bytes;
}

export function svgBytes(markup: string): Uint8Array {
  return new TextEncoder().encode(markup);
}

/** A minimal SVG document with the given opening-tag attributes. */
export function svgWith(attributes: string): Uint8Array {
  return svgBytes(`<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" ${attributes}></svg>`);
}
