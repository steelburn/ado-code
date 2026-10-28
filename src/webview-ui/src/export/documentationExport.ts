/**
 * documentationExport — the webview half of the documentation export round trip.
 *
 * Why this lives in the webview: rendering needs `docx` (Word), `fflate`
 * (XLSX) and a DOM canvas (mermaid → PNG). The sources live on disk, where only
 * the extension host can read them, so the flow is:
 *
 *   request `exportDocumentation`  ─────▶ host reads Markdown / images / CSVs
 *   ◀───── `documentationExportPayload`
 *   render here, then post `saveBinary` ─▶ host: save dialog + write
 *
 * The save path is the *existing* one (`promptAndSaveBinary`), so this module
 * never writes a file itself and there is no second implementation of "ask for
 * a name and write bytes".
 */
import { mdToDocBlocks } from '../../../shared/docBlocks';
import { rasterizeMermaidBlocks, stripResolvedWarnings } from '../../../shared/mermaidBlocks';
import type { RegisterSource } from '../../../shared/documentation/registerWorkbook';
import {
  buildDocxImages,
  describeExportSuccess,
  exportSavePlan,
  formatDocBlockWarning,
  formatExportWarning,
} from '../../../shared/documentation/exportPipeline';
import type {
  DocumentationExportFormat,
  DocumentationExportPayload,
} from '../../../shared/documentation/exportPayload';
import type { DocRole } from '../../../shared/documentation/krisa';
import { vscode } from '../vscode';
// docx, fflate and the canvas rasteriser cost ~330 KB together and are only needed
// when the user actually exports — so they are imported lazily inside the handlers
// below. Imported statically they land in webview.js, which is the chat panel's first load.

/** What happened, in terms the export bar can render without a second vocabulary. */
export interface ExportOutcome {
  ok: boolean;
  message: string;
  warnings: string[];
}

export interface ExportTarget {
  /** Absolute path of the documentation project folder. */
  projectPath: string;
  /** Project-relative (or absolute) Markdown document, for `docx` / `diagram-png`. */
  documentPath?: string;
  /** 1-based line of the mermaid fence, for `diagram-png`. */
  diagramLine?: number;
  format: DocumentationExportFormat;
}

/**
 * A host that never answers would leave the bar spinning forever, so the
 * request expires. Generous: a DOCX of a large manual can take a while to read.
 */
export const EXPORT_TIMEOUT_MS = 120_000;

function post(message: unknown): void {
  vscode?.postMessage(message);
}

let requestSeq = 0;
const waiters = new Map<string, (payload: DocumentationExportPayload) => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function settle(requestId: string): void {
  const timer = timers.get(requestId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(requestId);
  }
  waiters.delete(requestId);
}

/** Ask the host for the sources of one export. */
export function requestDocumentationExport(target: ExportTarget): Promise<DocumentationExportPayload> {
  requestSeq += 1;
  const requestId = `doc-export-${requestSeq}-${Date.now()}`;
  return new Promise<DocumentationExportPayload>((resolve) => {
    waiters.set(requestId, resolve);
    timers.set(
      requestId,
      setTimeout(() => {
        const waiter = waiters.get(requestId);
        if (!waiter) {
          return;
        }
        settle(requestId);
        waiter({
          ok: false,
          format: target.format,
          error: 'The extension host did not answer the export request in time.',
          warnings: [],
        });
      }, EXPORT_TIMEOUT_MS),
    );
    post({
      type: 'exportDocumentation',
      requestId,
      request: {
        projectPath: target.projectPath,
        format: target.format,
        documentPath: target.documentPath,
        diagramLine: target.diagramLine,
      },
    });
  });
}

/** Route an incoming `documentationExportPayload` to the request that awaits it. */
export function deliverDocumentationExportPayload(
  requestId: string,
  payload: DocumentationExportPayload,
): boolean {
  const waiter = waiters.get(requestId);
  if (!waiter) {
    return false;
  }
  settle(requestId);
  waiter(payload);
  return true;
}

/** Render + save. Only reached with a payload the host produced. */
export async function performDocumentationExport(
  payload: DocumentationExportPayload,
): Promise<ExportOutcome> {
  if (!payload.ok) {
    return { ok: false, message: payload.error, warnings: [...payload.warnings] };
  }

  try {
    switch (payload.format) {
      case 'xlsx':
        return await exportWorkbook(payload);
      case 'docx':
        return await exportWord(payload);
      case 'diagram-png':
        return await exportDiagram(payload);
    }
  } catch (error) {
    return {
      ok: false,
      message: `Export failed: ${error instanceof Error ? error.message : String(error)}`,
      warnings: [],
    };
  }
}

/** Request → render → save, as one call for the UI. */
export async function runDocumentationExport(target: ExportTarget): Promise<ExportOutcome> {
  const payload = await requestDocumentationExport(target);
  return performDocumentationExport(payload);
}

async function exportWorkbook(
  payload: Extract<DocumentationExportPayload, { format: 'xlsx' }>,
): Promise<ExportOutcome> {
  const { buildRegisterWorkbook } = await import('../../../shared/documentation/registerWorkbook');
  const built = buildRegisterWorkbook({
    projectName: payload.projectName,
    role: payload.role as DocRole,
    templateName: typeof payload.record.template === 'string' ? payload.record.template : undefined,
    version: typeof payload.record.version === 'string' ? payload.record.version : undefined,
    framework: typeof payload.record.framework === 'string' ? payload.record.framework : undefined,
    language: typeof payload.record.language === 'string' ? payload.record.language : undefined,
    registers: payload.sources as RegisterSource[],
  });

  const { renderXlsx } = await import('./xlsxRenderer');
  const rendered = renderXlsx(built.workbook);
  // Register diagnostics are already prefixed by the builder; the render step
  // adds archive-level ones (truncated cells, dropped values).
  const warnings = [
    ...payload.warnings,
    ...built.warnings,
    ...rendered.warnings.map(formatExportWarning),
  ];

  post({
    type: 'saveBinary',
    request: exportSavePlan('xlsx', rendered.base64, payload),
  });

  return { ok: true, message: describeExportSuccess('xlsx', payload, warnings), warnings };
}

async function exportWord(
  payload: Extract<DocumentationExportPayload, { format: 'docx' }>,
): Promise<ExportOutcome> {
  const parsed = mdToDocBlocks(payload.markdown);

  // Diagrams are rasterised *here*, not in the host: only the webview has a
  // canvas, and a `mermaid` fence is otherwise unrepresentable in Word.
  const { createMermaidRasterizer } = await import('./mermaidRaster');
  const substitution = await rasterizeMermaidBlocks(parsed.blocks, createMermaidRasterizer());
  const parsedWarnings = stripResolvedWarnings(parsed.warnings, substitution.resolvedLines);
  const warnings = [
    ...payload.warnings,
    ...substitution.warnings,
    ...parsedWarnings.map(formatDocBlockWarning),
  ];

  const { renderDocx } = await import('./docxRenderer');
  const rendered = await renderDocx(
    {
      ...parsed,
      blocks: substitution.blocks,
      warnings: parsedWarnings,
    },
    buildDocxImages(payload.images, substitution.images),
    { creator: 'ADO Code' },
  );

  warnings.push(...rendered.warnings);

  post({
    type: 'saveBinary',
    request: exportSavePlan('docx', rendered.base64, payload),
  });

  return { ok: true, message: describeExportSuccess('docx', payload, warnings), warnings };
}

async function exportDiagram(
  payload: Extract<DocumentationExportPayload, { format: 'diagram-png' }>,
): Promise<ExportOutcome> {
  const { rasterizeMermaidToPng } = await import('./mermaidRaster');
  const raster = await rasterizeMermaidToPng(payload.code);
  if (!raster.ok || !raster.pngBase64) {
    return {
      ok: false,
      message: raster.error ?? `Diagram "${payload.title}" could not be rasterised.`,
      warnings: [...payload.warnings, ...(raster.warnings ?? [])],
    };
  }

  const warnings = [...payload.warnings, ...(raster.warnings ?? [])];
  post({
    type: 'saveBinary',
    request: exportSavePlan('diagram-png', raster.pngBase64, payload),
  });

  return { ok: true, message: describeExportSuccess('diagram-png', payload, warnings), warnings };
}
