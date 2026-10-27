/**
 * svgRaster — the dependency-free half of mermaid → PNG conversion.
 *
 * A Word document cannot embed an SVG (`docx` would need a fallback raster,
 * and Word's SVG support is not something a government submission should
 * rely on), so every diagram has to become a PNG before it reaches the DOCX
 * renderer. The conversion itself needs a DOM (`<img>` + `<canvas>`), which
 * lives in `src/webview-ui/src/export/mermaidRaster.ts`; *everything else*
 * lives here so it can be unit tested headlessly:
 *
 *   1. sizing the SVG so the browser can decode it standalone
 *      (`forceSvgIntrinsicSize`) — an `<img>`-embedded SVG ignores the host
 *      page's CSS, so `width="100%"` and `style="max-width:…"` must be
 *      rewritten to real pixel dimensions first;
 *   2. choosing the raster scale (`planSvgRaster`) — a 2× render keeps text
 *      crisp in print, but the canvas has hard limits that must be respected
 *      deliberately rather than discovered as a blank image;
 *   3. the `data:` URI the `<img>` is loaded from. `blob:` is refused by the
 *      chat webview CSP (`img-src ${cspSource} data:`), and a `data:` URI is
 *      also the only source that does not taint the canvas, so
 *      `canvas.toDataURL()` is allowed to succeed;
 *   4. the mermaid `init` directive that forces a print-safe palette — a
 *      diagram rendered in the editor's dark theme is white-on-transparent
 *      and would be invisible on white paper.
 *
 * No `vscode`, no DOM, no dependencies: importable from the host, the webview
 * bundle and the headless test runner alike.
 */

import { imageSize } from './imageSize';

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/** Prefix of every rasterised diagram reference used in a document set. */
export const PNG_DATA_URI_PREFIX = 'data:image/png;base64,';

/**
 * Export defaults.
 *
 * `scale: 2` is a deliberate 192 dpi render: the `docx` renderer places
 * images at 96 dpi, so a 2× bitmap stays sharp when a reviewer prints the
 * manual or zooms to 200 % in Word.
 *
 * The canvas limits are the lowest common denominator across the Chromium
 * builds VS Code ships: 4096 px per side and 16 Mpx total are comfortably
 * inside every known limit, and hitting them silently is what produces a
 * blank white image instead of a diagram.
 */
export const RASTER_DEFAULTS = {
  scale: 2,
  maxDimensionPx: 4096,
  maxPixels: 16_000_000,
  /** Below this the diagram is so large that the bitmap would be unusable. */
  minScale: 0.25,
  /** Documents are printed on white paper, so transparency must be filled. */
  background: '#ffffff',
} as const;

/**
 * Fonts are resolved *inside* the SVG-as-image sandbox, where the VS Code
 * `--vscode-font-family` custom property does not exist (no cascade reaches
 * an `<img>`-embedded SVG). Named families therefore have to be spelled out
 * or the diagram falls back to the viewer's default sans-serif.
 */
export const RASTER_FONT_FAMILY = 'Segoe UI, Arial, Helvetica, sans-serif';

/* -------------------------------------------------------------------------- */
/* Base64 / data URI                                                           */
/* -------------------------------------------------------------------------- */

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * UTF-8 safe base64. `btoa` throws on any code point above U+00FF, which rules
 * it out for a Bahasa Malaysia document (and for mermaid labels using arrows
 * or box-drawing characters), while `Buffer` does not exist in the webview.
 */
export function encodeUtf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let out = '';
  let i = 0;

  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      B64_ALPHABET[(n >> 18) & 63] +
      B64_ALPHABET[(n >> 12) & 63] +
      B64_ALPHABET[(n >> 6) & 63] +
      B64_ALPHABET[n & 63];
  }

  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64_ALPHABET[(n >> 18) & 63] + B64_ALPHABET[(n >> 12) & 63] + '==';
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out +=
      B64_ALPHABET[(n >> 18) & 63] +
      B64_ALPHABET[(n >> 12) & 63] +
      B64_ALPHABET[(n >> 6) & 63] +
      '=';
  }

  return out;
}

/** The only form of SVG reference the chat webview CSP (and the canvas) accepts. */
export function svgToDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${encodeUtf8Base64(svg)}`;
}

/* -------------------------------------------------------------------------- */
/* SVG geometry                                                                */
/* -------------------------------------------------------------------------- */

export interface SvgSize {
  width: number;
  height: number;
}

const ABSOLUTE_UNITS: Record<string, number> = {
  '': 1,
  px: 1,
  pt: 96 / 72,
  pc: 16,
  mm: 96 / 25.4,
  cm: 96 / 2.54,
  in: 96,
  em: 16,
  ex: 8,
};

/**
 * A single SVG length in px at 96 dpi, or `null` when it is not absolute.
 * Percentages are explicitly rejected: `width="100%"` has no intrinsic
 * meaning outside a viewport, which is exactly the problem being solved.
 */
export function parseSvgLength(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*([a-z%]*)\s*$/i.exec(value);
  if (!m) {
    return null;
  }
  const unit = m[2].toLowerCase();
  if (unit === '%') {
    return null;
  }
  const factor = ABSOLUTE_UNITS[unit];
  if (factor === undefined) {
    return null;
  }
  const n = Number(m[1]) * factor;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** `viewBox="minX minY width height"` → positive dimensions, or `null`. */
export function parseViewBox(value: string | undefined): SvgSize | null {
  if (!value) {
    return null;
  }
  const parts = value.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return null;
  }
  const [, , width, height] = parts;
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Intrinsic size of a standalone SVG document (`<svg>` attributes only). */
export function svgDimensions(svg: string): SvgSize | null {
  const tag = rootSvgTag(svg);
  if (!tag) {
    return null;
  }
  return sizeFromAttributes(tag.attributes);
}

/**
 * Locate the root `<svg …>` element and return its attributes. The scan
 * respects quoted attribute values so a `>` inside `style="…"` cannot
 * truncate the tag.
 */
function rootSvgTag(svg: string): { start: number; end: number; attributes: SvgAttribute[] } | null {
  const open = /<svg\b/i.exec(svg);
  if (!open) {
    return null;
  }
  const start = open.index;
  let i = start + open[0].length;
  let quote = '';
  for (; i < svg.length; i++) {
    const ch = svg[i];
    if (quote) {
      if (ch === quote) {
        quote = '';
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      break;
    }
  }
  if (i >= svg.length) {
    return null;
  }
  const raw = svg.slice(start + open[0].length, i);
  return { start, end: i, attributes: parseSvgAttributes(raw) };
}

interface SvgAttribute {
  name: string;
  value: string;
}

function parseSvgAttributes(raw: string): SvgAttribute[] {
  const attributes: SvgAttribute[] = [];
  const re = /([:\w.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    attributes.push({ name: m[1], value: m[3] !== undefined ? m[3] : m[4] });
  }
  return attributes;
}

function sizeFromAttributes(attributes: SvgAttribute[]): SvgSize | null {
  const get = (name: string) =>
    attributes.find((a) => a.name.toLowerCase() === name)?.value;

  const viewBox = parseViewBox(get('viewbox'));
  if (viewBox) {
    return viewBox;
  }

  const width = parseSvgLength(get('width'));
  const height = parseSvgLength(get('height'));
  return width && height ? { width, height } : null;
}

export interface ForcedSvgSize {
  ok: true;
  svg: string;
  size: SvgSize;
  /** True when the source had no usable intrinsic size and the viewBox was used. */
  fromViewBox: boolean;
}

export interface ForcedSvgError {
  ok: false;
  reason: 'no-svg-root' | 'no-intrinsic-size';
}

/**
 * Rewrite the root `<svg>` so it renders at a fixed pixel size.
 *
 * This is what makes `data:`-URI rasterisation work at all: mermaid emits
 * `width="100%"` plus `style="max-width: 640px"`, and an SVG loaded into an
 * `<img>` has no percentage to resolve against, so it draws at the browser
 * default (300×150) or not at all. `style` is dropped (an `<img>`-embedded
 * SVG cannot use it for layout anyway) and `viewBox` is preserved so the
 * drawing scales into the new viewport instead of being cropped.
 */
export function forceSvgIntrinsicSize(svg: string): ForcedSvgSize | ForcedSvgError {
  const tag = rootSvgTag(svg);
  if (!tag) {
    return { ok: false, reason: 'no-svg-root' };
  }

  const get = (name: string) => tag.attributes.find((a) => a.name.toLowerCase() === name)?.value;
  const viewBox = parseViewBox(get('viewbox'));
  const attrWidth = parseSvgLength(get('width'));
  const attrHeight = parseSvgLength(get('height'));

  let size: SvgSize | null = null;
  let fromViewBox = false;
  if (viewBox) {
    size = viewBox;
    fromViewBox = true;
  } else if (attrWidth && attrHeight) {
    size = { width: attrWidth, height: attrHeight };
  } else if (attrWidth || attrHeight) {
    // One axis pinned: a square is the only defensible guess.
    const side = (attrWidth || attrHeight) as number;
    size = { width: side, height: side };
  }

  if (!size) {
    return { ok: false, reason: 'no-intrinsic-size' };
  }

  const width = Math.max(1, Math.round(size.width));
  const height = Math.max(1, Math.round(size.height));

  const kept = tag.attributes.filter(
    (a) => !['width', 'height', 'style', 'xmlns'].includes(a.name.toLowerCase()),
  );
  const parts = [
    '<svg',
    ' xmlns="http://www.w3.org/2000/svg"',
    ` width="${width}"`,
    ` height="${height}"`,
  ];
  if (!viewBox) {
    parts.push(` viewBox="0 0 ${width} ${height}"`);
  }
  for (const attribute of kept) {
    if (attribute.name.toLowerCase() === 'viewbox') {
      parts.push(` viewBox="${attribute.value}"`);
      continue;
    }
    parts.push(` ${attribute.name}="${escapeAttribute(attribute.value)}"`);
  }
  parts.push('>');

  return {
    ok: true,
    svg: svg.slice(0, tag.start) + parts.join('') + svg.slice(tag.end + 1),
    size: { width, height },
    fromViewBox,
  };
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/* -------------------------------------------------------------------------- */
/* Raster planning                                                             */
/* -------------------------------------------------------------------------- */

export interface RasterOptions {
  /** Pixel multiplier; 2 renders at 192 dpi for print. */
  scale?: number;
  maxDimensionPx?: number;
  maxPixels?: number;
  minScale?: number;
}

export interface RasterPlanOk {
  ok: true;
  sourceWidth: number;
  sourceHeight: number;
  canvasWidth: number;
  canvasHeight: number;
  /** Effective multiplier after clamping (`canvasWidth / sourceWidth`). */
  scale: number;
  warnings: string[];
}

export interface RasterPlanError {
  ok: false;
  error: string;
}

export type RasterPlan = RasterPlanOk | RasterPlanError;

function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

/**
 * Decide the canvas size for a diagram.
 *
 * Clamping is *reported*, never silent: a 4000-px-wide flowchart rendered at
 * 2× exceeds every browser canvas limit, and the failure mode of ignoring
 * that is a blank image in a submitted document. The plan explains what it
 * did so the export can carry the explanation into the warnings list.
 */
export function planSvgRaster(source: SvgSize, options: RasterOptions = {}): RasterPlan {
  const width = Number(source?.width);
  const height = Number(source?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { ok: false, error: 'the diagram has no usable intrinsic size' };
  }

  const requested = clampNumber(options.scale, RASTER_DEFAULTS.scale, 0.1, 8);
  const maxDimension = Math.max(256, Math.floor(clampNumber(options.maxDimensionPx, RASTER_DEFAULTS.maxDimensionPx, 256, 16384)));
  const maxPixels = Math.max(65_536, Math.floor(clampNumber(options.maxPixels, RASTER_DEFAULTS.maxPixels, 65_536, 268_435_456)));
  const minScale = clampNumber(options.minScale, RASTER_DEFAULTS.minScale, 0.01, requested);

  const warnings: string[] = [];
  let scale = requested;

  let canvasWidth = Math.round(width * scale);
  let canvasHeight = Math.round(height * scale);

  const longest = Math.max(canvasWidth, canvasHeight);
  if (longest > maxDimension) {
    scale = (maxDimension / longest) * scale;
    canvasWidth = Math.max(1, Math.round(width * scale));
    canvasHeight = Math.max(1, Math.round(height * scale));
    warnings.push(
      `Diagram rendered at ${formatScale(scale)} instead of ${formatScale(requested)}: ` +
        `${width}×${height} px scaled by ${formatScale(requested)} would exceed the ` +
        `${maxDimension} px canvas limit.`,
    );
  }

  if (canvasWidth * canvasHeight > maxPixels) {
    const shrink = Math.sqrt(maxPixels / (canvasWidth * canvasHeight));
    scale *= shrink;
    canvasWidth = Math.max(1, Math.round(canvasWidth * shrink));
    canvasHeight = Math.max(1, Math.round(canvasHeight * shrink));
    warnings.push(
      `Diagram rendered at ${formatScale(scale)}: ${Math.round(canvasWidth)}×${Math.round(canvasHeight)} px ` +
        `keeps the bitmap under the ${maxPixels.toLocaleString('en-US')} pixel canvas limit.`,
    );
  }

  if (scale < minScale) {
    return {
      ok: false,
      error:
        `the diagram is too large to rasterise (${width}×${height} px would fit only at ` +
        `${formatScale(scale)}, below the ${formatScale(minScale)} minimum); ` +
        'reduce the diagram or split it into smaller ones',
    };
  }

  return { ok: true, sourceWidth: width, sourceHeight: height, canvasWidth, canvasHeight, scale, warnings };
}

function formatScale(scale: number): string {
  return `${Math.round(scale * 100) / 100}×`;
}

/* -------------------------------------------------------------------------- */
/* mermaid directives / captions                                               */
/* -------------------------------------------------------------------------- */

/**
 * Mermaid's per-diagram configuration directive.
 *
 * * `theme: 'default'` — the export must not inherit the editor's dark theme,
 *   which would put white text on white paper.
 * * explicit colours — `default` alone still tints node fills from the theme,
 *   and a screenshot-quality diagram is worth the four extra keys.
 * * `htmlLabels: false` — HTML labels are `<foreignObject>` content, which
 *   Chromium does not reliably render inside an `<img>`-sourced SVG, i.e. the
 *   labels would silently vanish from the PNG. mermaid 12 honours only the
 *   ROOT-level key (`flowchart.htmlLabels` is ignored, directive or not), so
 *   both forms are emitted — the scoped keys still matter on mermaid 10/11.
 * * explicit `fontFamily` — the VS Code CSS variable does not exist in the
 *   sandbox (see `RASTER_FONT_FAMILY`).
 */
export const EXPORT_INIT_DIRECTIVE =
  '%%{init: ' +
  JSON.stringify({
    theme: 'default',
    // mermaid 12 reads `htmlLabels` from the ROOT config; the per-diagram
    // keys below are ignored there (probe-verified in a real webview).
    htmlLabels: false,
    themeVariables: {
      background: '#ffffff',
      primaryColor: '#eef2f7',
      primaryTextColor: '#111111',
      primaryBorderColor: '#5a6b7d',
      secondaryColor: '#f5f7fa',
      tertiaryColor: '#ffffff',
      lineColor: '#33404d',
      textColor: '#111111',
      fontFamily: RASTER_FONT_FAMILY,
    },
    flowchart: { htmlLabels: false, curve: 'basis' },
    class: { htmlLabels: false },
  }) +
  '}%%';

/** True when the author already pinned mermaid config in the fence. */
export function hasInitDirective(code: string): boolean {
  return /^\s*%%\{[^}]*init\s*:/m.test(code);
}

/**
 * Prefix the diagram with the export directive unless the author already
 * supplied one — mermaid documents exactly one `init` directive per diagram,
 * and silently overriding an author's choice would be worse than honouring it.
 */
export function withExportDirective(code: string): { code: string; applied: boolean } {
  if (hasInitDirective(code)) {
    return { code, applied: false };
  }
  return { code: `${EXPORT_INIT_DIRECTIVE}\n${code.replace(/^\s+/, '')}`, applied: true };
}

const DIAGRAM_TITLES: Record<string, string> = {
  flowchart: 'Flowchart',
  graph: 'Flowchart',
  sequencediagram: 'Sequence diagram',
  classdiagram: 'Class diagram',
  statediagram: 'State diagram',
  statediagramv2: 'State diagram',
  erdiagram: 'ER diagram',
  gantt: 'Gantt chart',
  pie: 'Pie chart',
  journey: 'User journey',
  timeline: 'Timeline',
  mindmap: 'Mind map',
  gitgraph: 'Git graph',
  quadrantchart: 'Quadrant chart',
  requirementdiagram: 'Requirement diagram',
  c4context: 'C4 context diagram',
  block: 'Block diagram',
  architecture: 'Architecture diagram',
  sankey: 'Sankey diagram',
  xychart: 'XY chart',
  radar: 'Radar chart',
  packet: 'Packet diagram',
  kanban: 'Kanban board',
};

/**
 * A caption for the generated image — this becomes the DOCX `alt` text and
 * the media register's `CAPTION` column, so it has to say something a reader
 * (or a screen reader) can use.
 */
export function diagramCaption(code: string, index = 1): string {
  const accTitle = /^\s*accTitle\s*:\s*(.+)$/m.exec(code);
  if (accTitle && accTitle[1].trim()) {
    return truncateCaption(accTitle[1].trim());
  }

  const body = code
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('%%'));

  const first = body[0] ?? '';
  const kind = DIAGRAM_TITLES[first.split(/\s+/)[0]?.toLowerCase() ?? ''];
  if (kind) {
    return kind;
  }
  if (first) {
    return truncateCaption(first);
  }
  return `Diagram ${index}`;
}

function truncateCaption(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 120 ? `${collapsed.slice(0, 117)}…` : collapsed;
}

/**
 * A filesystem-safe stem for a saved diagram, e.g.
 * `DIA-003-to-be-approval-flow`. Mirrors the media-register naming rule so a
 * rasterised diagram can be written to `diagrams/` under its register id.
 */
export function diagramFileName(mediaId: string, caption: string): string {
  const slug = caption
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  const id = mediaId.trim().toUpperCase().replace(/[^A-Z0-9-]+/g, '-');
  return slug ? `${id}-${slug}` : id || 'diagram';
}

/* -------------------------------------------------------------------------- */
/* PNG validation                                                              */
/* -------------------------------------------------------------------------- */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Guard for the canvas result: a failed `toDataURL` yields an empty or bogus string. */
export function isValidPngBytes(bytes: Uint8Array): boolean {
  if (!bytes || bytes.length < 8) {
    return false;
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Validate a base64 PNG produced by the canvas and return its real dimensions,
 * so the caller embeds the bitmap it actually got rather than the size it
 * asked for. Returns `null` for anything that is not a PNG.
 */
export function inspectPngBase64(base64: string): { bytes: number; size: SvgSize } | null {
  if (!base64) {
    return null;
  }
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(base64);
  } catch {
    return null;
  }
  if (!isValidPngBytes(bytes)) {
    return null;
  }
  const dims = imageSize(bytes);
  if (!dims || dims.format !== 'png') {
    return null;
  }
  return { bytes: bytes.length, size: { width: dims.width, height: dims.height } };
}

function decodeBase64(base64: string): Uint8Array {
  const clean = base64.replace(/\s+/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const length = Math.floor((clean.length * 3) / 4) - padding;
  const out = new Uint8Array(length);
  let outIndex = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === '=') {
      break;
    }
    const value = B64_ALPHABET.indexOf(ch);
    if (value < 0) {
      throw new Error(`invalid base64 character: ${ch}`);
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex++] = (buffer >> bits) & 0xff;
    }
  }
  return outIndex === out.length ? out : out.subarray(0, outIndex);
}
