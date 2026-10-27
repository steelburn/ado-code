/**
 * imageSize — dependency-free intrinsic-dimension sniffing for documentation
 * media (screenshots, illustrative figures, diagram exports).
 *
 * Why this exists: Word ignores CSS width constraints. `docx`'s `ImageRun`
 * needs explicit pixel dimensions measured at 96 dpi, so every image going into
 * a generated manual, test-evidence appendix or diagram set has to be scaled to
 * the A4 content width *before* it is written. Reading the dimensions from the
 * file header is stricter than trusting a file extension or an author's width
 * hint, and it keeps the export path free of an image-decoding library.
 *
 * Supported: PNG, JPEG (all SOF variants), GIF (87a/89a), WebP (VP8/VP8L/VP8X),
 * BMP, SVG (width/height with units, else viewBox).
 * Anything else reports `unknown` — this module never throws.
 */

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'svg' | 'unknown';

export interface ImageDimensions {
  format: ImageFormat;
  width: number;
  height: number;
}

/** Word / `docx` measure images in px at 96 dpi; 1 px = 9525 EMU. */
export const DOCX_DPI = 96;

/**
 * Usable text width of an A4 page at 96 dpi: 210 mm = 794 px, minus 20 mm
 * margins on both sides (2 x 76 px) = 642, rounded down.
 */
export const A4_CONTENT_WIDTH_PX = 640;

/** Extensions offered by the media-intake file dialog. */
export const SUPPORTED_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] as const;

const MIME_BY_FORMAT: Record<ImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  unknown: 'application/octet-stream',
};

export function formatToMime(format: ImageFormat): string {
  return MIME_BY_FORMAT[format] ?? 'application/octet-stream';
}

/* ------------------------------------------------------------------ */
/* byte readers                                                        */
/* ------------------------------------------------------------------ */

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset < 0 || offset + text.length > bytes.length) {
    return false;
  }
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

function readU16BE(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1];
}

function readU32BE(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function readU16LE(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}

function readU32LE(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function readI32LE(b: Uint8Array, o: number): number {
  return readU32LE(b, o) | 0;
}

function readU24LE(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
}

/* ------------------------------------------------------------------ */
/* format sniffing                                                     */
/* ------------------------------------------------------------------ */

const SVG_HEAD_LIMIT = 8192;
const SVG_TAG_RE = /<svg\b([^>]*)>/i;

function decodeHead(bytes: Uint8Array): string {
  const head = bytes.subarray(0, Math.min(bytes.length, SVG_HEAD_LIMIT));
  let label = 'utf-8';
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) {
    label = 'utf-16le';
  } else if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) {
    label = 'utf-16be';
  }
  try {
    return new TextDecoder(label).decode(head).replace(/^\uFEFF/, '');
  } catch {
    let out = '';
    for (let i = 0; i < head.length; i++) {
      out += String.fromCharCode(head[i]);
    }
    return out;
  }
}

/** True when the bytes look like SVG markup, tolerating an XML decl / comments / doctype. */
function looksLikeSvg(bytes: Uint8Array): boolean {
  if (bytes.length === 0) {
    return false;
  }
  return SVG_TAG_RE.test(decodeHead(bytes));
}

export function sniffImageFormat(bytes: Uint8Array): ImageFormat {
  if (!bytes || bytes.length === 0) {
    return 'unknown';
  }
  if (bytes.length >= 8 && asciiAt(bytes, 0, '\u0089PNG\r\n\u001A\n')) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  if (asciiAt(bytes, 0, 'GIF87a') || asciiAt(bytes, 0, 'GIF89a')) {
    return 'gif';
  }
  if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) {
    return 'webp';
  }
  if (asciiAt(bytes, 0, 'BM')) {
    return 'bmp';
  }
  if (looksLikeSvg(bytes)) {
    return 'svg';
  }
  return 'unknown';
}

/* ------------------------------------------------------------------ */
/* per-format intrinsic size                                           */
/* ------------------------------------------------------------------ */

/** PNG: signature is 8 bytes, then the IHDR chunk; width/height are big-endian at 16/20. */
function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) {
    return null;
  }
  return { width: readU32BE(bytes, 16), height: readU32BE(bytes, 20) };
}

/** GIF: logical screen descriptor packs width then height as little-endian 16-bit. */
function gifSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 10) {
    return null;
  }
  return { width: readU16LE(bytes, 6), height: readU16LE(bytes, 8) };
}

/**
 * JPEG: walk the marker chain to the first Start-Of-Frame segment. Not every
 * marker carries a length, and entropy-coded data must never be scanned, so the
 * length field is used to skip whole segments.
 */
const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    let marker = bytes[offset + 1];
    while (marker === 0xff && offset + 2 < bytes.length) {
      offset++;
      marker = bytes[offset + 1];
    }
    // Markers without a payload: SOI, TEM and the restart markers.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) {
      return null; // EOI or start-of-scan before any SOF
    }
    const length = readU16BE(bytes, offset + 2);
    if (length < 2) {
      return null;
    }
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (offset + 9 > bytes.length) {
        return null;
      }
      return { height: readU16BE(bytes, offset + 5), width: readU16BE(bytes, offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

/** WebP: three container variants, all after the RIFF/WEBP header at byte 12. */
function webpSize(bytes: Uint8Array): { width: number; height: number } | null {
  const payload = 20;
  if (asciiAt(bytes, 12, 'VP8 ') && bytes.length >= payload + 10) {
    // Lossy: 3-byte frame tag, 3-byte start code 9D 01 2A, then 14-bit w/h.
    if (bytes[payload + 3] !== 0x9d || bytes[payload + 4] !== 0x01 || bytes[payload + 5] !== 0x2a) {
      return null;
    }
    return { width: readU16LE(bytes, payload + 6) & 0x3fff, height: readU16LE(bytes, payload + 8) & 0x3fff };
  }
  if (asciiAt(bytes, 12, 'VP8L') && bytes.length >= payload + 5) {
    // Lossless: 0x2F signature, then 14-bit (width-1) and 14-bit (height-1).
    if (bytes[payload] !== 0x2f) {
      return null;
    }
    const packed = readU32LE(bytes, payload + 1);
    return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
  }
  if (asciiAt(bytes, 12, 'VP8X') && bytes.length >= 30) {
    // Extended: 4 flag/reserved bytes, then 24-bit (width-1) and (height-1).
    return { width: readU24LE(bytes, payload + 4) + 1, height: readU24LE(bytes, payload + 7) + 1 };
  }
  return null;
}

/** BMP: DIB header holds signed 32-bit width/height; a negative height means top-down. */
function bmpSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 26) {
    return null;
  }
  return { width: readI32LE(bytes, 18), height: Math.abs(readI32LE(bytes, 22)) };
}

const SVG_LENGTH_RE = /^\s*([+]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(px|pt|pc|mm|cm|in|em|ex|%)?\s*$/i;

/** SVG units are resolved to px at 96 dpi; percentages are not intrinsic and are rejected. */
function parseSvgLength(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const match = SVG_LENGTH_RE.exec(value);
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  switch ((match[2] || 'px').toLowerCase()) {
    case 'px':
      return amount;
    case 'pt':
      return (amount * DOCX_DPI) / 72;
    case 'pc':
      return amount * 16;
    case 'mm':
      return (amount * DOCX_DPI) / 25.4;
    case 'cm':
      return (amount * DOCX_DPI) / 2.54;
    case 'in':
      return amount * DOCX_DPI;
    case 'em':
      return amount * 16;
    case 'ex':
      return amount * 8;
    default:
      return null;
  }
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const attributeRe = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = attributeRe.exec(source)) !== null) {
    attributes[match[1].toLowerCase()] = match[2] !== undefined ? match[2] : match[3];
  }
  return attributes;
}

function parseViewBox(value: string | undefined): { width: number; height: number } | null {
  if (!value) {
    return null;
  }
  const parts = value.trim().split(/[\s,]+/);
  if (parts.length !== 4) {
    return null;
  }
  const width = Number(parts[2]);
  const height = Number(parts[3]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

/**
 * SVG: prefer explicit width/height attributes (unit-aware), fall back to the
 * viewBox, and derive whichever dimension is missing from the viewBox aspect
 * ratio. A document with neither is genuinely unbounded — report null rather
 * than inventing a size.
 */
function svgSize(bytes: Uint8Array): { width: number; height: number } | null {
  const tag = SVG_TAG_RE.exec(decodeHead(bytes));
  if (!tag) {
    return null;
  }
  const attributes = parseAttributes(tag[1]);
  const width = parseSvgLength(attributes.width);
  const height = parseSvgLength(attributes.height);
  const viewBox = parseViewBox(attributes.viewbox);

  if (width !== null && height !== null) {
    return { width, height };
  }
  if (!viewBox) {
    return null;
  }
  if (width !== null) {
    return { width, height: (width * viewBox.height) / viewBox.width };
  }
  if (height !== null) {
    return { width: (height * viewBox.width) / viewBox.height, height };
  }
  return { width: viewBox.width, height: viewBox.height };
}

function intrinsicSize(bytes: Uint8Array, format: ImageFormat): { width: number; height: number } | null {
  switch (format) {
    case 'png':
      return pngSize(bytes);
    case 'jpeg':
      return jpegSize(bytes);
    case 'gif':
      return gifSize(bytes);
    case 'webp':
      return webpSize(bytes);
    case 'bmp':
      return bmpSize(bytes);
    case 'svg':
      return svgSize(bytes);
    default:
      return null;
  }
}

/**
 * Intrinsic pixel size of an image, or null when the format is unsupported or
 * the header is truncated/unparseable. Never throws: a broken image reference
 * must degrade to a warning in the export, not an exception.
 */
export function imageSize(bytes: Uint8Array): ImageDimensions | null {
  if (!bytes || bytes.length === 0) {
    return null;
  }
  const format = sniffImageFormat(bytes);
  const size = intrinsicSize(bytes, format);
  if (!size) {
    return null;
  }
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) {
    return null;
  }
  if (size.width <= 0 || size.height <= 0) {
    return null;
  }
  return { format, width: Math.round(size.width), height: Math.round(size.height) };
}

/**
 * Scale an image down to a maximum content width, preserving the aspect ratio.
 * Images narrower than the cap are never upscaled — a 200 px screenshot blown up
 * to 640 px looks worse in Word than it does inline.
 */
export function fitToContentWidth(
  width: number,
  height: number,
  maxWidthPx: number = A4_CONTENT_WIDTH_PX,
): { width: number; height: number } {
  const cap = maxWidthPx > 0 ? maxWidthPx : A4_CONTENT_WIDTH_PX;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 1, height: 1 };
  }
  if (width <= cap) {
    return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  }
  return { width: Math.max(1, Math.round(cap)), height: Math.max(1, Math.round((height * cap) / width)) };
}
