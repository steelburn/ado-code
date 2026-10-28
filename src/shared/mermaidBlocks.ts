/**
 * mermaidBlocks — turn ` ```mermaid ` fences into real images for export.
 *
 * The parser deliberately reports a mermaid fence as an `unsupported` block
 * instead of silently dropping it, because a document-controlled deliverable
 * must never lose content without saying so. For the DOCX/PDF path that
 * report is only the *fallback*: diagrams should appear in the manual, not be
 * mentioned in a warning list.
 *
 * This module bridges the two. It walks the parsed blocks, hands every mermaid
 * fence to an injected rasteriser, and swaps the fence for an `image` block
 * whose reference is a `data:` URI — which the existing image pipeline already
 * understands (`imageAssets` decodes `data:` refs in memory and `imageSize`
 * sniffs the PNG header for the DOCX `ImageRun` dimensions). So rasterisation
 * needs **no new renderer code path at all**.
 *
 * The rasteriser is injected rather than imported so this stays dependency-
 * free and headless-testable: `src/webview-ui/src/export/mermaidRaster.ts`
 * supplies the DOM/canvas implementation, and the tests supply a stub.
 *
 * Failure policy: a diagram that cannot be rasterised keeps its `unsupported`
 * block (so the export still states the omission) *and* produces a warning
 * naming the line and the reason. Nothing is silently lost.
 */

import type { DocBlock, DocBlockWarning } from './docBlocks';
import { diagramCaption, PNG_DATA_URI_PREFIX } from './svgRaster';

export interface DiagramRasterRequest {
  /** The fence body, without the ```` ```mermaid ```` markers. */
  code: string;
  /** Caption/alt text derived from the diagram source. */
  caption: string;
  /** 1-based line of the opening fence. */
  line: number;
  /** 1-based index among the mermaid fences in this document. */
  index: number;
}

export interface RasterizedDiagram {
  ok: boolean;
  /** Base64 PNG payload, without the `data:` prefix. */
  pngBase64?: string;
  width?: number;
  height?: number;
  /** Non-fatal notes, e.g. a canvas clamp applied during rasterisation. */
  warnings?: string[];
  error?: string;
}

export type DiagramRasterizer = (
  request: DiagramRasterRequest,
) => Promise<RasterizedDiagram> | RasterizedDiagram;

export interface DiagramImageRef {
  line: number;
  /** The `data:` URI the block now carries. */
  ref: string;
  caption: string;
  width?: number;
  height?: number;
}

export interface MermaidSubstitution {
  /** Blocks with mermaid fences replaced by `image` blocks where possible. */
  blocks: DocBlock[];
  /** Rasteriser failures and clamps, prefixed with the diagram's line. */
  warnings: string[];
  /**
   * Lines whose mermaid `unsupported` block was resolved. The caller drops the
   * parser's "mermaid omitted" warnings for these lines, so a successfully
   * rendered diagram produces no warnings at all.
   */
  resolvedLines: number[];
  rasterised: number;
  failed: number;
  images: DiagramImageRef[];
}

/**
 * Replace every mermaid fence with a rasterised `image` block.
 *
 * Blocks are processed in order and awaited sequentially: mermaid renders into
 * the DOM one diagram at a time and the rasteriser shares a canvas, so running
 * them concurrently gains nothing and risks interleaved results.
 */
export async function rasterizeMermaidBlocks(
  blocks: DocBlock[],
  rasterize: DiagramRasterizer,
): Promise<MermaidSubstitution> {
  const out: DocBlock[] = [];
  const warnings: string[] = [];
  const resolvedLines: number[] = [];
  const images: DiagramImageRef[] = [];
  let rasterised = 0;
  let failed = 0;
  let index = 0;

  for (const block of blocks) {
    if (block.kind !== 'unsupported' || block.reason !== 'mermaid') {
      out.push(block);
      continue;
    }

    index += 1;
    const caption = diagramCaption(block.raw, index);

    let result: RasterizedDiagram;
    try {
      result = await rasterize({ code: block.raw, caption, line: block.line, index });
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    if (result.ok && result.pngBase64) {
      const ref = `${PNG_DATA_URI_PREFIX}${result.pngBase64}`;
      out.push({ kind: 'image', ref, alt: caption });
      resolvedLines.push(block.line);
      images.push({ line: block.line, ref, caption, width: result.width, height: result.height });
      rasterised += 1;
      for (const warning of result.warnings ?? []) {
        warnings.push(`Diagram at line ${block.line} (${caption}): ${warning}`);
      }
      continue;
    }

    failed += 1;
    warnings.push(
      `Diagram at line ${block.line} (${caption}) could not be included: ${result.error || 'the rasteriser returned no PNG'}`,
    );
    // Keep the original block so the renderer still reports the omission.
    out.push(block);
  }

  return { blocks: out, warnings, resolvedLines, rasterised, failed, images };
}

/**
 * Drop parser warnings that a successful rasterisation made obsolete.
 *
 * Only the mermaid warnings on exactly those lines are removed — an unrelated
 * warning on the same line (a stray inline HTML tag, say) survives, so the
 * filter can never hide a second problem hiding behind the first.
 */
export function stripResolvedWarnings(
  warnings: DocBlockWarning[],
  resolvedLines: readonly number[],
): DocBlockWarning[] {
  if (resolvedLines.length === 0) {
    return warnings.slice();
  }
  const resolved = new Set(resolvedLines);
  return warnings.filter((warning) => !(resolved.has(warning.line) && isMermaidWarning(warning)));
}

function isMermaidWarning(warning: DocBlockWarning): boolean {
  const text = `${warning.code ?? ''} ${warning.message ?? ''}`.toLowerCase();
  return text.includes('mermaid');
}
