/**
 * mermaidRaster — the DOM half of mermaid → PNG.
 *
 * Everything that can be decided without a browser lives in
 * `src/shared/svgRaster.ts` (sizing, scale clamping, the `data:` URI, the
 * print-safe mermaid directive); this module only does the three things that
 * genuinely need a DOM:
 *
 *   mermaid.render → <svg> → forceSvgIntrinsicSize → <img src="data:…">  → <canvas> → PNG base64
 *
 * Two CSP details drive the design (both verified against `ChatViewProvider`):
 * `img-src` allows `${cspSource}` and `data:` but **not** `blob:`, so the
 * familiar `URL.createObjectURL(svgBlob)` trick is unusable here; and a
 * `data:` URI is also the only `img` source that leaves the canvas untainted,
 * which is what lets `toDataURL()` return pixels instead of throwing
 * `SecurityError`.
 *
 * Failure is always reported as `{ ok: false, error }` rather than an
 * exception, so an export can carry on and state the omission.
 */

import mermaid from 'mermaid';

import type { DiagramRasterizer, RasterizedDiagram } from '../../../shared/mermaidBlocks';
import {
  forceSvgIntrinsicSize,
  inspectPngBase64,
  planSvgRaster,
  RASTER_DEFAULTS,
  svgToDataUri,
  withExportDirective,
  type RasterOptions,
} from '../../../shared/svgRaster';
import { initMermaid } from '../utils/mermaid';

export interface MermaidRasterOptions extends RasterOptions {
  /** Canvas fill; documents are printed on white paper. */
  background?: string;
}

let renderSequence = 0;

/**
 * Render one mermaid source to a PNG.
 *
 * The returned `width`/`height` are read back out of the produced PNG header,
 * not taken from the plan — an embed that trusts the requested size instead
 * of the bitmap it received is how a diagram ends up stretched or cropped in
 * Word.
 */
export async function rasterizeMermaidToPng(
  code: string,
  options: MermaidRasterOptions = {},
): Promise<RasterizedDiagram> {
  if (!code.trim()) {
    return { ok: false, error: 'the diagram is empty' };
  }

  // Establishes `securityLevel`/`suppressErrorRendering`; the export directive
  // below pins the palette, so the editor theme cannot leak into the document.
  initMermaid();

  const id = `adocode-docx-diagram-${++renderSequence}`;
  const prepared = withExportDirective(code);
  const warnings: string[] = [];

  let svg: string;
  try {
    const rendered = await mermaid.render(id, prepared.code);
    svg = typeof rendered === 'string' ? rendered : rendered?.svg ?? '';
  } catch (err) {
    return {
      ok: false,
      error: `mermaid could not render this diagram: ${errorMessage(err)}`,
    };
  }

  if (!svg.trim()) {
    return { ok: false, error: 'mermaid produced an empty diagram' };
  }

  const sized = forceSvgIntrinsicSize(svg);
  if (!sized.ok) {
    return {
      ok: false,
      error:
        sized.reason === 'no-svg-root'
          ? 'mermaid produced no <svg> element'
          : 'the diagram declares no width, height or viewBox, so it cannot be sized for the page',
    };
  }

  const plan = planSvgRaster(sized.size, options);
  if (!plan.ok) {
    return { ok: false, error: plan.error };
  }
  warnings.push(...plan.warnings);

  let pngBase64: string | null;
  try {
    pngBase64 = await drawToPng(
      sized.svg,
      plan.canvasWidth,
      plan.canvasHeight,
      options.background ?? RASTER_DEFAULTS.background,
    );
  } catch (err) {
    return { ok: false, error: `the diagram could not be rasterised: ${errorMessage(err)}` };
  }

  if (!pngBase64) {
    return { ok: false, error: 'the canvas is unavailable, so the diagram could not be rasterised' };
  }

  const inspected = inspectPngBase64(pngBase64);
  if (!inspected) {
    return { ok: false, error: 'rasterisation produced no valid PNG data' };
  }

  return {
    ok: true,
    pngBase64,
    width: inspected.size.width,
    height: inspected.size.height,
    warnings,
  };
}

/**
 * A `DiagramRasterizer` for `rasterizeMermaidBlocks` — one instance is reused
 * across a document so the per-diagram options and the mermaid init cost are
 * paid once.
 */
export function createMermaidRasterizer(options: MermaidRasterOptions = {}): DiagramRasterizer {
  return (request) => rasterizeMermaidToPng(request.code, options);
}

/** Load an SVG `data:` URI into an `<img>` and paint it onto a canvas. */
async function drawToPng(
  svg: string,
  width: number,
  height: number,
  background: string,
): Promise<string | null> {
  if (typeof document === 'undefined') {
    return null;
  }

  const image = await loadImage(svgToDataUri(svg));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return null;
  }

  // Fill first: a mermaid SVG is transparent, and Word composites onto white —
  // but an "empty" transparent PNG reads as a blank figure in every preview.
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, width, height);

  // Throws `SecurityError` only if the canvas was tainted, which a `data:` URI
  // cannot cause — the try/catch is for exotic environments, not the norm.
  const url = canvas.toDataURL('image/png');
  const marker = 'base64,';
  const index = url.indexOf(marker);
  return index >= 0 ? url.slice(index + marker.length) : null;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('the rendered SVG could not be decoded'));
    image.src = src;
  });
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  const text = String(err ?? 'unknown error');
  return text.length > 200 ? `${text.slice(0, 197)}…` : text;
}
