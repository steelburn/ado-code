/**
 * Wire contract for the documentation export round trip.
 *
 * Why a round trip at all: the export *renderers* live in the webview bundle
 * (`docx`, `fflate`, `mermaid`, DOM + canvas), while the *sources* live on
 * disk, where only the extension host can read them. So the webview asks the
 * host for a payload, builds the file itself, and hands the resulting bytes
 * back through the existing `saveBinary` message — one save path, no second
 * implementation of "write a file and prompt for a location".
 *
 * This module is pure: no `vscode`, no `node:path`, no DOM. Both sides import
 * it, and the validation is unit-testable without a host.
 *
 * Validation deliberately does NOT echo the caller's request back verbatim —
 * unknown keys are dropped and every accepted field is re-derived. A webview is
 * a renderer of untrusted-ish content, so the host must never act on an
 * arbitrary field it did not itself validate.
 */

import type { RegisterKind, RegisterSource } from './registerWorkbook';

export type DocumentationExportFormat = 'xlsx' | 'docx' | 'diagram-png';

/** Accepted `format` values, in the order the UI should offer them. */
export const DOCUMENTATION_EXPORT_FORMATS: readonly DocumentationExportFormat[] = [
  'xlsx',
  'docx',
  'diagram-png',
];

/**
 * Where generated artefacts go. Gitignored by the scaffolder — the scripts,
 * column definitions and metadata that *produce* the export are committed, the
 * output is not.
 */
export const DEFAULT_EXPORT_DIR = 'export/out';

export interface DocumentationExportRequest {
  /** Absolute path of the documentation project folder. */
  projectPath: string;
  format: DocumentationExportFormat;
  /**
   * Absolute or project-relative path of the Markdown document to export.
   * Required for `docx` and `diagram-png`; ignored for `xlsx`.
   */
  documentPath?: string;
  /** 1-based line of the mermaid fence to rasterise (`diagram-png` only). */
  diagramLine?: number;
}

/* ------------------------------------------------------------------ */
/* Images                                                              */
/* ------------------------------------------------------------------ */

/**
 * Structural subset of the host's `ImageAsset`: exactly what a renderer needs,
 * without importing the host module (which depends on `vscode`).
 */
export interface ExportedImageAsset {
  /** Every reference in the document that resolves to this file. */
  refs: string[];
  /** Absolute path on disk; empty for inline `data:` images. */
  filePath: string;
  relativePath: string;
  mime: string;
  format: string;
  /** Fitted size, already clamped to the A4 content width. */
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  /** Raw bytes, base64 — the renderer feeds this straight to `ImageRun`. */
  base64: string;
}

/**
 * Index assets by every reference that points at them.
 *
 * One implementation, used by the webview renderer and by tests — the DOCX
 * path resolves images through exactly this lookup, so a second, subtly
 * different copy would be a silent "image missing from the document" bug.
 */
export function indexAssetsByRef(
  assets: readonly ExportedImageAsset[],
): Record<string, ExportedImageAsset> {
  const byRef: Record<string, ExportedImageAsset> = {};
  for (const asset of assets) {
    for (const ref of asset.refs) byRef[ref] = asset;
  }
  return byRef;
}

/* ------------------------------------------------------------------ */
/* Payloads                                                            */
/* ------------------------------------------------------------------ */

export interface RegisterExportPayload {
  ok: true;
  format: 'xlsx';
  projectName: string;
  role: string;
  /** `.ado-code/documentation.json`, verbatim — read-only provenance. */
  record: Record<string, unknown>;
  sources: RegisterSource[];
  present: RegisterKind[];
  missing: RegisterKind[];
  suggestedFileName: string;
  defaultDir: string;
  warnings: string[];
}

export interface DocxExportPayload {
  ok: true;
  format: 'docx';
  projectPath: string;
  documentPath: string;
  /** Path relative to the project folder — the source of the export name. */
  relativePath: string;
  markdown: string;
  images: ExportedImageAsset[];
  suggestedFileName: string;
  defaultDir: string;
  warnings: string[];
}

export interface DiagramExportPayload {
  ok: true;
  format: 'diagram-png';
  projectPath: string;
  documentPath: string;
  relativePath: string;
  /** 1-based line of the fence in the source document. */
  line: number;
  /** 0-based index of the diagram within the document. */
  index: number;
  /** Mermaid source, fences already stripped. */
  code: string;
  title: string;
  suggestedFileName: string;
  defaultDir: string;
  warnings: string[];
}

export interface ExportFailurePayload {
  ok: false;
  /** Null when the request was rejected before a format was established. */
  format: DocumentationExportFormat | null;
  error: string;
  warnings: string[];
}

export type DocumentationExportPayload =
  | RegisterExportPayload
  | DocxExportPayload
  | DiagramExportPayload
  | ExportFailurePayload;

/* ------------------------------------------------------------------ */
/* Request validation                                                  */
/* ------------------------------------------------------------------ */

export type ExportRequestCheck =
  | { ok: true; request: DocumentationExportRequest }
  | { ok: false; error: string };

export function isDocumentationExportFormat(
  value: unknown,
): value is DocumentationExportFormat {
  return (
    typeof value === 'string' &&
    (DOCUMENTATION_EXPORT_FORMATS as readonly string[]).includes(value)
  );
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // A NUL byte in a path is never legitimate and truncates some filesystem APIs.
  if (trimmed.includes('\u0000')) return null;
  return trimmed;
}

/**
 * Validate and normalise an incoming export request.
 *
 * Rejections are worded for the user (they surface in a toast), and every
 * accepted field is rebuilt from scratch so nothing unvalidated crosses the
 * boundary.
 */
export function normaliseExportRequest(raw: unknown): ExportRequestCheck {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'Invalid export request.' };
  }
  const candidate = raw as Record<string, unknown>;

  const projectPath = nonEmptyString(candidate.projectPath);
  if (!projectPath) {
    return { ok: false, error: 'Export needs a project folder.' };
  }

  const format = candidate.format;
  if (!isDocumentationExportFormat(format)) {
    return { ok: false, error: `Unsupported export format: ${String(format)}` };
  }

  if (format === 'xlsx') {
    return { ok: true, request: { projectPath, format } };
  }

  const documentPath = nonEmptyString(candidate.documentPath);
  if (!documentPath) {
    return { ok: false, error: 'Export needs a Markdown document to read.' };
  }

  if (format === 'docx') {
    return { ok: true, request: { projectPath, format, documentPath } };
  }

  // diagram-png — `diagramLine` is optional. The export bar cannot know a fence
  // line without parsing the document, so omitting it means "the first diagram";
  // a value that *is* supplied still has to be a real 1-based line number.
  const line = candidate.diagramLine;
  if (line === undefined || line === null) {
    return { ok: true, request: { projectPath, format, documentPath } };
  }
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
    return {
      ok: false,
      error: 'The diagram line must be a whole line number (1 or greater).',
    };
  }
  return { ok: true, request: { projectPath, format, documentPath, diagramLine: line } };
}

/* ------------------------------------------------------------------ */
/* File naming                                                         */
/* ------------------------------------------------------------------ */

/** Last path segment without its extension (`04-user-docs/user-manual.md` → `user-manual`). */
export function stemOf(filePath: string): string {
  const normalised = filePath.replace(/\\/g, '/');
  const base = normalised.slice(normalised.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function safeSegment(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned || fallback;
}

/** `user-manual` → `user-manual.docx`. */
export function docxFileName(relativePath: string): string {
  return `${safeSegment(stemOf(relativePath), 'document')}.docx`;
}

/**
 * `user-manual` + diagram index → `user-manual-diagram-2.png`.
 * The index is 1-based so it matches what a person counts in the source file.
 */
export function diagramFileName(documentName: string, index: number): string {
  const n = Number.isFinite(index) && index > 0 ? Math.floor(index) : 1;
  return `${safeSegment(stemOf(documentName), 'diagram')}-diagram-${n}.png`;
}

/** Fallback name when the project metadata carries no name (audit-safe, not empty). */
export function xlsxFileName(projectName: string): string {
  return `${safeSegment(projectName, 'documentation')}-registers.xlsx`;
}

/** Human label for a format, for toasts and menu items. */
export function exportFormatLabel(format: DocumentationExportFormat): string {
  switch (format) {
    case 'xlsx':
      return 'Excel workbook';
    case 'docx':
      return 'Word document';
    case 'diagram-png':
      return 'Diagram PNG';
  }
}

/** One-line outcome, used to build the user-facing toast message. */
export function describeExportPayload(payload: DocumentationExportPayload): string {
  if (!payload.ok) return payload.error;
  switch (payload.format) {
    case 'xlsx':
      return `Excel workbook built from ${payload.sources.length} register(s)`;
    case 'docx':
      return `Word document built from ${payload.markdown.length} characters of Markdown`;
    case 'diagram-png':
      return `Diagram "${payload.title}" rasterised`;
  }
}
