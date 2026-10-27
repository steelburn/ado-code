/**
 * Host side of the documentation export round trip.
 *
 * Responsibilities, all of them "read something the webview cannot reach":
 *   - validate the request (never trust a webview field),
 *   - resolve the document path *inside* the project folder,
 *   - read the Markdown, parse it with the shared block parser to learn which
 *     images and diagrams it references,
 *   - fetch those image bytes (base64 + fitted dimensions) so the DOCX renderer
 *     never has to touch disk,
 *   - collect the register CSVs for the workbook.
 *
 * Everything that renders — Word, XLSX, mermaid → PNG — stays in the webview,
 * where `docx`/`fflate`/`mermaid`/canvas already live. This module returns
 * plain, JSON-safe data and is a pure function of the filesystem plus the
 * injected `readFile`, which is what makes it testable without a real host.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { mdToDocBlocks, DocBlock, DocFrontMatter } from '../../shared/docBlocks';
import { collectImageAssets } from '../imageAssets';
import { collectRegisterSources } from './registerSources';
import {
  DEFAULT_EXPORT_DIR,
  DiagramExportPayload,
  DocxExportPayload,
  DocumentationExportPayload,
  DocumentationExportRequest,
  ExportedImageAsset,
  RegisterExportPayload,
  diagramFileName,
  docxFileName,
  normaliseExportRequest,
  xlsxFileName,
} from '../../shared/documentation/exportPayload';

export interface ExportDeps {
  /** Injected for tests; defaults to `vscode.workspace.fs` (Thenable, hence PromiseLike). */
  readFile?: (uri: vscode.Uri) => PromiseLike<Uint8Array>;
}

function failure(
  format: DocumentationExportPayload['format'] | null,
  error: string,
  warnings: string[] = [],
): DocumentationExportPayload {
  return { ok: false, format: format as DocumentationExportPayload['format'], error, warnings };
}

function decode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}

/* ------------------------------------------------------------------ */
/* Path handling                                                       */
/* ------------------------------------------------------------------ */

export interface ResolvedDocument {
  absolutePath: string;
  relativePath: string;
}

/**
 * Resolve a document reference to an absolute path that is guaranteed to sit
 * inside the project folder.
 *
 * The bound check is the reason this exists: `../../../../etc/passwd.md` must
 * be refused before any read, exactly like the image resolver does. A relative
 * reference resolves against the project root, which is what a project's own
 * files use (`04-user-docs/user-manual.md`).
 */
export function resolveDocumentPath(
  projectPath: string,
  documentPath: string,
): ResolvedDocument | null {
  const root = path.resolve(projectPath);
  const absolute = path.isAbsolute(documentPath)
    ? path.resolve(documentPath)
    : path.resolve(root, documentPath);

  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;

  return { absolutePath: absolute, relativePath: relative.replace(/\\/g, '/') };
}

/* ------------------------------------------------------------------ */
/* Block inspection                                                    */
/* ------------------------------------------------------------------ */

interface ImageReference {
  ref: string;
}

function imageRefs(blocks: readonly DocBlock[]): ImageReference[] {
  const refs: ImageReference[] = [];
  for (const block of blocks) {
    if (block.kind === 'image') refs.push({ ref: block.ref });
  }
  return refs;
}

export interface MermaidFence {
  line: number;
  index: number;
  code: string;
}

/** Strip a ```` ```mermaid ```` fence if the parser kept it in `raw`. */
function stripFence(raw: string): string {
  const lines = raw.split(/\r?\n/);
  if (!lines.length) return '';
  if (/^\s*```/.test(lines[0])) lines.shift();
  while (lines.length && /^\s*```\s*$/.test(lines[lines.length - 1])) lines.pop();
  return lines.join('\n').trim();
}

/**
 * Mermaid fences as the parser reports them: `unsupported` blocks whose reason
 * is `mermaid`. They stay unsupported on purpose — a Word document cannot carry
 * a live diagram, so the export substitutes a rasterised PNG or states the
 * omission.
 */
export function mermaidFences(blocks: readonly DocBlock[]): MermaidFence[] {
  const fences: MermaidFence[] = [];
  for (const block of blocks) {
    if (block.kind !== 'unsupported' || block.reason !== 'mermaid') continue;
    fences.push({
      line: block.line,
      index: fences.length,
      code: stripFence(block.raw),
    });
  }
  return fences;
}

/* ------------------------------------------------------------------ */
/* Collectors                                                          */
/* ------------------------------------------------------------------ */

async function collectWorkbook(
  request: DocumentationExportRequest,
  deps: ExportDeps,
): Promise<DocumentationExportPayload> {
  const projectRoot = vscode.Uri.file(path.resolve(request.projectPath));
  const collected = await collectRegisterSources(projectRoot, {
    readFile: deps.readFile,
  });

  const payload: RegisterExportPayload = {
    ok: true,
    format: 'xlsx',
    projectName: collected.projectName,
    role: collected.role,
    record: collected.record as Record<string, unknown>,
    sources: collected.sources,
    present: collected.present,
    missing: collected.missing,
    suggestedFileName: collected.suggestedFileName || xlsxFileName(collected.projectName),
    defaultDir: DEFAULT_EXPORT_DIR,
    warnings: collected.warnings,
  };
  return payload;
}

async function readDocument(
  projectPath: string,
  documentPath: string,
  deps: ExportDeps,
): Promise<{ ok: true; resolved: ResolvedDocument; text: string } | { ok: false; error: string }> {
  const resolved = resolveDocumentPath(projectPath, documentPath);
  if (!resolved) {
    return { ok: false, error: 'That document is outside the project folder.' };
  }
  const readFile = deps.readFile ?? ((uri: vscode.Uri) => vscode.workspace.fs.readFile(uri));
  try {
    const bytes = await readFile(vscode.Uri.file(resolved.absolutePath));
    return { ok: true, resolved, text: decode(bytes) };
  } catch {
    return { ok: false, error: `Could not read ${resolved.relativePath}.` };
  }
}

async function collectDocx(
  request: DocumentationExportRequest,
  deps: ExportDeps,
): Promise<DocumentationExportPayload> {
  const read = await readDocument(request.projectPath, request.documentPath!, deps);
  if (!read.ok) return failure('docx', read.error);

  const parsed = mdToDocBlocks(read.text);
  const warnings = parsed.warnings.map((w) => `Line ${w.line}: ${w.message}`);

  // Zero references is the common case: the resolver is only worth calling
  // when the document actually embeds something.
  let images: ExportedImageAsset[] = [];
  if (imageRefs(parsed.blocks).length > 0) {
    const collection = await collectImageAssets({
      documentPath: read.resolved.absolutePath,
      refs: imageRefs(parsed.blocks).map((r) => r.ref),
      projectRoot: path.resolve(request.projectPath),
    });
    images = collection.assets.map(toExportedAsset);
    warnings.push(...collection.warnings);
  } else if (parsed.warnings.some((w) => w.code === 'unsupported-mermaid')) {
    warnings.push('Diagrams are not embedded in Word: export them as PNG first.');
  }

  const payload: DocxExportPayload = {
    ok: true,
    format: 'docx',
    projectPath: path.resolve(request.projectPath),
    documentPath: read.resolved.absolutePath,
    relativePath: read.resolved.relativePath,
    markdown: read.text,
    images,
    suggestedFileName: docxFileName(read.resolved.relativePath),
    defaultDir: DEFAULT_EXPORT_DIR,
    warnings: dedupe(warnings),
  };
  return payload;
}

function toExportedAsset(asset: {
  refs: string[];
  filePath: string;
  relativePath: string;
  mime: string;
  format: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  base64: string;
}): ExportedImageAsset {
  return {
    refs: [...asset.refs],
    filePath: asset.filePath,
    relativePath: asset.relativePath,
    mime: asset.mime,
    format: asset.format,
    width: asset.width,
    height: asset.height,
    originalWidth: asset.originalWidth,
    originalHeight: asset.originalHeight,
    base64: asset.base64,
  };
}

async function collectDiagram(
  request: DocumentationExportRequest,
  deps: ExportDeps,
): Promise<DocumentationExportPayload> {
  const read = await readDocument(request.projectPath, request.documentPath!, deps);
  if (!read.ok) return failure('diagram-png', read.error);

  const parsed = mdToDocBlocks(read.text);
  const fences = mermaidFences(parsed.blocks);
  if (!fences.length) {
    return failure('diagram-png', `No diagram found in ${read.resolved.relativePath}.`);
  }

  // The export bar cannot know fence line numbers without parsing the
  // document itself, so an unspecified line means "the first diagram".
  const wanted = request.diagramLine ?? fences[0].line;
  const fence = fences.find((f) => f.line === wanted);
  if (!fence) {
    return failure(
      'diagram-png',
      `No diagram at line ${wanted} of ${read.resolved.relativePath}.`,
    );
  }
  if (!fence.code.trim()) {
    return failure('diagram-png', `The diagram at line ${wanted} is empty.`);
  }

  const payload: DiagramExportPayload = {
    ok: true,
    format: 'diagram-png',
    projectPath: path.resolve(request.projectPath),
    documentPath: read.resolved.absolutePath,
    relativePath: read.resolved.relativePath,
    line: fence.line,
    index: fence.index,
    code: fence.code,
    title: diagramTitle(parsed.meta, fence.index),
    suggestedFileName: diagramFileName(read.resolved.relativePath, fence.index + 1),
    defaultDir: DEFAULT_EXPORT_DIR,
    warnings: [],
  };
  return payload;
}

function diagramTitle(meta: DocFrontMatter, index: number): string {
  const base = typeof meta.title === 'string' && meta.title.trim() ? meta.title.trim() : 'diagram';
  return index === 0 ? base : `${base} (${index + 1})`;
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Build the export payload for a request coming from the webview.
 *
 * Never throws: a failure is a payload with `ok: false`, so the caller posts a
 * single message shape either way and the UI has one place to handle errors.
 */
export async function collectDocumentationExport(
  request: unknown,
  deps: ExportDeps = {},
): Promise<DocumentationExportPayload> {
  const check = normaliseExportRequest(request);
  if (!check.ok) return failure(null, check.error);

  const normalised = check.request;
  try {
    switch (normalised.format) {
      case 'xlsx':
        return await collectWorkbook(normalised, deps);
      case 'docx':
        return await collectDocx(normalised, deps);
      case 'diagram-png':
        return await collectDiagram(normalised, deps);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failure(normalised.format, `Export failed: ${message}`);
  }
}
