/**
 * Documentation export pipeline — every decision an export makes that does not
 * need a renderer, a DOM or `vscode`.
 *
 * Why a separate module: the export runs in the tab's webview bundle (that is
 * where `docx`, `fflate` and the canvas live) but the bytes and names it must
 * produce are contract, not rendering. Keeping them here means the naming, MIME
 * and image-collection rules are unit tested headlessly, and the webview half
 * (`webview-ui/src/export/documentationExport.ts`) is left with nothing but
 * "call the renderer, then hand the bytes to the save bridge".
 */
import type { DocxImageAsset, DocxImageCollection } from '../docxLayout';
import type { DiagramImageRef } from '../mermaidBlocks';
import { PNG_DATA_URI_PREFIX } from '../svgRaster';
import type {
  DiagramExportPayload,
  DocxExportPayload,
  DocumentationExportFormat,
  ExportedImageAsset,
  RegisterExportPayload,
} from './exportPayload';

/**
 * MIME types for the generated artefacts. These are the strings the save bridge
 * turns into a dialog filter and an extension, so they must be the real Office
 * values — not `application/octet-stream`, which would hand the user
 * `report.docx.octet-stream`.
 */
export const EXPORT_MIME: Record<DocumentationExportFormat, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'diagram-png': 'image/png',
};

/** What the webview posts through the `saveBinary` message. */
export interface ExportSavePlan {
  /** Bare base64 — the save bridge accepts a `data:` prefix but does not need one. */
  content: string;
  mime: string;
  defaultName: string;
  /** Project-relative folder the dialog should open in (`export/out`). */
  defaultDir: string;
}

/** Human name for each format — used in outcome messages. */
export function exportFormatNoun(format: DocumentationExportFormat): string {
  switch (format) {
    case 'xlsx':
      return 'register workbook';
    case 'docx':
      return 'Word document';
    case 'diagram-png':
      return 'diagram';
  }
}

/**
 * Build the save request for a finished artefact.
 *
 * The file name and folder come from the *host* (which resolved them against
 * the project), so the webview cannot invent a path: it only supplies bytes.
 */
export function exportSavePlan(
  format: DocumentationExportFormat,
  base64: string,
  payload: DocxExportPayload | RegisterExportPayload | DiagramExportPayload,
): ExportSavePlan {
  return {
    content: base64,
    mime: EXPORT_MIME[format],
    defaultName: payload.suggestedFileName,
    defaultDir: payload.defaultDir,
  };
}

/**
 * Merge the host's resolved assets with the diagrams the webview rasterised.
 *
 * Both halves end up in one `byRef` map because `planDocument` looks images up
 * by the reference written in the Markdown — and after rasterisation a mermaid
 * fence's block carries a `data:` URI that no on-disk asset matches.
 */
export function buildDocxImages(
  assets: readonly ExportedImageAsset[],
  diagrams: readonly DiagramImageRef[] = [],
): DocxImageCollection {
  const byRef: Record<string, DocxImageAsset> = {};

  for (const asset of assets) {
    if (!asset.base64) {
      continue;
    }
    const entry: DocxImageAsset = {
      refs: [...asset.refs],
      mime: asset.mime,
      format: asset.format,
      width: asset.width,
      height: asset.height,
      base64: asset.base64,
    };
    for (const ref of asset.refs) {
      byRef[ref] = entry;
    }
  }

  for (const diagram of diagrams) {
    const entry = rasterizedImageAsset(diagram);
    if (entry) {
      byRef[diagram.ref] = entry;
    }
  }

  return { byRef };
}

/**
 * A rasterised diagram as a Word image asset.
 *
 * The PNG never touched disk, so its base64 is recovered from the `data:` URI
 * the block carries — one less thing to thread through the substitution API.
 * Dimensions are optional on the rasteriser's result; when they are absent the
 * plan reports the block as `no-dimensions` rather than guessing a size and
 * delivering a distorted image.
 */
export function rasterizedImageAsset(diagram: DiagramImageRef): DocxImageAsset | null {
  const ref = diagram.ref || '';
  if (!ref.startsWith(PNG_DATA_URI_PREFIX)) {
    return null;
  }
  const base64 = ref.slice(PNG_DATA_URI_PREFIX.length);
  if (!base64) {
    return null;
  }
  return {
    refs: [ref],
    mime: 'image/png',
    format: 'png',
    width: diagram.width && diagram.width > 0 ? diagram.width : 0,
    height: diagram.height && diagram.height > 0 ? diagram.height : 0,
    base64,
  };
}

/**
 * One line per warning, with the sheet/row/column it belongs to.
 *
 * The workbook builder produces structured diagnostics (so a test can assert on
 * a code rather than prose); anything user-facing needs a string, and this is
 * the single place that formatting happens.
 */
export function formatExportWarning(warning: {
  message: string;
  sheet?: string;
  row?: number;
  column?: string;
}): string {
  const where: string[] = [];
  if (warning.sheet) {
    where.push(warning.sheet);
  }
  if (typeof warning.row === 'number' && warning.row > 0) {
    where.push(`row ${warning.row}`);
  }
  if (warning.column) {
    where.push(`column ${warning.column}`);
  }
  return where.length === 0 ? warning.message : `${warning.message} [${where.join(', ')}]`;
}

/**
 * A parser/layout warning as one line: `Line 87: …`.
 *
 * The warning carries a 1-based line number so an author can jump straight to
 * the offending Markdown, which is useless if the line is dropped on the way
 * to the export bar.
 */
export function formatDocBlockWarning(warning: {
  line: number;
  message: string;
}): string {
  return warning.line > 0 ? `Line ${warning.line}: ${warning.message}` : warning.message;
}

/**
 * Outcome line for the export bar. Kept here so the wording is testable and the
 * webview does not grow its own second vocabulary for the same three events.
 */
export function describeExportSuccess(
  format: DocumentationExportFormat,
  payload: DocxExportPayload | RegisterExportPayload | DiagramExportPayload,
  warnings: readonly string[] = [],
): string {
  const noun = exportFormatNoun(format);
  const base = `Built ${payload.suggestedFileName} (${noun})`;
  return warnings.length === 0 ? base : `${base} — ${warnings.length} warning(s)`;
}
