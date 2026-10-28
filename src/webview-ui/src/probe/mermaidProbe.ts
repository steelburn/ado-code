/**
 * Mermaid render probe — the last unobserved link in the diagram export chain.
 *
 * Everything downstream of `mermaid.render()` is already proven in a real VS
 * Code webview (the `docExportSmoke` test drives a hand-written SVG through
 * `data:` URI → `<img>` → `<canvas>` → `toDataURL`). What was never observed is
 * mermaid's *own* output taking that path, because `webview-ui-dist/mermaid.js`
 * exposes no global to call.
 *
 * This module is therefore built into a throwaway chunk by
 * `webpack.probe.config.js` (output: `.ado-code/probe-dist/`, which is both
 * gitignored and `.vscodeignore`d, so it can never reach a VSIX). It calls the
 * PRODUCTION rasteriser — `rasterizeMermaidToPng` — not a copy, so what gets
 * observed is the code the export bar actually runs.
 *
 * The probe reports facts, not verdicts; the test asserts them. Notably it
 * measures INK (non-background pixels) in the produced bitmap, which is the
 * only way to distinguish "the canvas produced bytes" from "the diagram was
 * actually drawn" — a blank 640×480 PNG passes every structural check.
 */

import mermaid from 'mermaid';
import { initMermaid } from '../utils/mermaid';
import { forceSvgIntrinsicSize, withExportDirective } from '../../../shared/svgRaster';
import { rasterizeMermaidToPng } from '../export/mermaidRaster';

/** Root `<svg …>` start tag, used to inspect mermaid's raw attributes. */
function rootTagOf(svg: string): string {
  const start = svg.indexOf('<svg');
  if (start < 0) {
    return '';
  }
  const end = svg.indexOf('>', start);
  return end > start ? svg.slice(start, end + 1) : '';
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('the produced PNG could not be loaded back into an <img>'));
    img.src = src;
  });
}

/**
 * Count opaque and non-background pixels in a PNG produced by the rasteriser.
 *
 * Drawing the PNG back into a canvas proves two things at once: the bytes are a
 * decodable image (not a truncated/garbage buffer) and they contain a drawing.
 */
async function measureInk(pngBase64: string): Promise<{ width: number; height: number; opaque: number; ink: number }> {
  const img = await loadImage(`data:image/png;base64,${pngBase64}`);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('the probe canvas has no 2d context');
  }
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let opaque = 0;
  let ink = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 8) {
      opaque += 1;
      // The rasteriser fills white, so anything meaningfully darker is content.
      if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) {
        ink += 1;
      }
    }
  }
  return { width: canvas.width, height: canvas.height, opaque, ink };
}

export interface MermaidRenderProbeResult {
  ok: boolean;
  error?: string;
  mermaidVersion?: string;
  renderReturnKind?: 'string' | 'object';
  svgLength?: number;
  rootTag?: string;
  /** mermaid emits `width="100%"` — the reason `forceSvgIntrinsicSize` exists. */
  rawHasPercentWidth?: boolean;
  rawHasStyleAttr?: boolean;
  rawHasViewBox?: boolean;
  forcedOk?: boolean;
  forcedWidth?: number;
  forcedHeight?: number;
  forcedError?: string;
  forcedPercentWidth?: boolean;
  rasterOk?: boolean;
  rasterError?: string;
  rasterWidth?: number;
  rasterHeight?: number;
  rasterBytes?: number;
  rasterWarnings?: string[];
  pngMagic?: string;
  ink?: number;
  opaquePixels?: number;
  totalPixels?: number;
  leftoverNodes?: number;
  /** Script elements the webview added — proof webpack fetched sibling chunks. */
  chunkScripts?: number;
  chunkFiles?: string[];
  /** Marker returned by a module that MUST be fetched as its own chunk. */
  lazyChunkMarker?: string;
  lazyChunkError?: string;
  /**
   * Which configuration actually turns HTML labels off on the installed
   * mermaid? `htmlLabels: false` exists because Chromium does not reliably
   * render `<foreignObject>` labels inside an `<img>`-sourced SVG — the labels
   * would silently vanish from the PNG. This measures the claim per strategy
   * instead of trusting the directive to be honoured.
   */
  labelChecks?: Array<{ name: string; foreignObjects: number; hasLabel: boolean }>;
}

let sequence = 0;

/** Render one mermaid source and return its SVG string. */
async function renderSvg(code: string): Promise<string> {
  sequence += 1;
  const raw = (await mermaid.render(`ado-code-probe-${sequence}`, code)) as unknown;
  return typeof raw === 'string' ? raw : (raw as { svg: string }).svg;
}

/**
 * Drive mermaid + the production rasteriser and report what happened.
 *
 * Never throws: the test needs the partial facts even when a step fails, and a
 * probe that dies leaves the operator guessing which step broke.
 */
export async function runMermaidProbe(code: string): Promise<MermaidRenderProbeResult> {
  const result: MermaidRenderProbeResult = { ok: false };
  try {
    initMermaid();
    const api = mermaid as unknown as { version?: string; mermaidAPI?: { version?: string } };
    result.mermaidVersion = api.version ?? api.mermaidAPI?.version ?? 'unknown';

    sequence += 1;
    const raw = (await mermaid.render(`ado-code-probe-${sequence}`, code)) as unknown;
    result.renderReturnKind = typeof raw === 'string' ? 'string' : 'object';
    const svg = typeof raw === 'string' ? raw : (raw as { svg: string }).svg;
    result.svgLength = svg?.length ?? 0;
    const tag = rootTagOf(svg ?? '');
    result.rootTag = tag;
    result.rawHasPercentWidth = /\bwidth\s*=\s*["']\s*\d+(\.\d+)?%\s*["']/.test(tag);
    result.rawHasStyleAttr = /\bstyle\s*=/.test(tag);
    result.rawHasViewBox = /\bviewBox\s*=/.test(tag);

    const forced = forceSvgIntrinsicSize(svg ?? '');
    if (forced && typeof forced === 'object' && 'ok' in forced && forced.ok) {
      result.forcedOk = true;
      result.forcedWidth = forced.size.width;
      result.forcedHeight = forced.size.height;
      result.forcedPercentWidth = /\bwidth\s*=\s*["']\s*\d+(\.\d+)?%\s*["']/.test(rootTagOf(forced.svg));
    } else {
      const failure = forced as { ok: false; reason: string };
      result.forcedOk = false;
      result.forcedError = failure?.reason ?? 'forceSvgIntrinsicSize failed';
    }

    const raster = await rasterizeMermaidToPng(code);
    if (raster.ok && raster.pngBase64) {
      const pngBase64 = raster.pngBase64;
      result.rasterOk = true;
      result.rasterWidth = raster.width;
      result.rasterHeight = raster.height;
      result.rasterBytes = pngBase64.length;
      result.rasterWarnings = raster.warnings;
      result.pngMagic = pngBase64.slice(0, 8);
      const ink = await measureInk(pngBase64);
      result.ink = ink.ink;
      result.opaquePixels = ink.opaque;
      result.totalPixels = ink.width * ink.height;
    } else {
      result.rasterOk = false;
      result.rasterError = raster.error;
    }

    // --- which config form actually disables HTML labels? -------------------
    // "htmlLabels: false" is only worth having if mermaid honours it; if a
    // release ignores it, labels go back inside <foreignObject> and vanish from
    // every exported PNG — silently, which is the failure this whole path exists
    // to prevent. Measure the candidates rather than assume the form is right.
    const labelCode = ['graph TD', '  A[Approved] --> B[Rejected]'].join('\n');
    const variants: Array<{ name: string; setup?: () => void; code: string }> = [
      { name: 'plain', code: labelCode },
      { name: 'directive', code: withExportDirective(labelCode).code },
      {
        name: 'global-flowchart',
        setup: () => mermaid.initialize({ flowchart: { htmlLabels: false } } as never),
        code: labelCode,
      },
      {
        name: 'global-root',
        setup: () => mermaid.initialize({ htmlLabels: false } as never),
        code: labelCode,
      },
    ];
    result.labelChecks = [];
    for (const variant of variants) {
      if (variant.setup) {
        variant.setup();
      } else {
        initMermaid();
      }
      const svg = await renderSvg(variant.code);
      result.labelChecks.push({
        name: variant.name,
        foreignObjects: (svg.match(/<foreignObject/gi) ?? []).length,
        hasLabel: svg.includes('Approved'),
      });
    }
    initMermaid();

    // Force one webpack-level chunk fetch (the mechanism the export bar uses).
    // This is the assertion that would have caught "Automatic publicPath is not
    // supported in this browser" instead of a downstream symptom.
    try {
      const lazy = await import('./probeLazy');
      result.lazyChunkMarker = lazy.lazyChunkMarker();
    } catch (err) {
      result.lazyChunkError = err instanceof Error ? err.message : String(err);
    }

    // mermaid lazy-loads its diagram renderers, so webpack injects <script src>
    // elements for the sibling chunks it fetches. Recording them turns "the
    // render succeeded" into "the chunk loader worked under the CSP".
    const scripts = Array.from(document.querySelectorAll('script[src]'));
    result.chunkScripts = scripts.length;
    result.chunkFiles = scripts.map((s) => {
      const src = (s as HTMLScriptElement).src || '';
      return src.slice(src.lastIndexOf('/') + 1) || src;
    });

    // mermaid injects temporary nodes while measuring; leftovers would leak into
    // the chat panel's DOM on every export.
    result.leftoverNodes = document.querySelectorAll('[id^="ado-code-probe-"], [id^="dado-code-probe-"]').length;
    result.ok = Boolean(result.rasterOk && result.forcedOk);
    return result;
  } catch (err) {
    result.ok = false;
    result.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return result;
  }
}

declare global {
  interface Window {
    __adoCodeMermaidProbe?: (code?: string) => Promise<MermaidRenderProbeResult>;
  }
}

const DEFAULT_CODE = [
  'graph TD',
  '  A[Requirement REQ-001] --> B[Test case TC-001]',
  '  B --> C{Pass?}',
  '  C -->|Yes| D[UAT sign-off]',
  '  C -->|No| E[Defect DEF-001]',
].join('\n');

window.__adoCodeMermaidProbe = (code?: string) => runMermaidProbe(code ?? DEFAULT_CODE);
