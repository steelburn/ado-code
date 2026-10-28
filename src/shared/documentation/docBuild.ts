/**
 * Documentation *building* as a reusable, vscode-free operation.
 *
 * Until now the New Project wizard was the only way to create a documentation
 * project: `ProjectCreationService` resolved a folder and called the
 * scaffolder directly, so the agent had no way in and "write me the BA document
 * set" degenerated into hand-writing a dozen files from memory.
 *
 * This module is the shared seam both callers use:
 *   - `describeDocTemplates()` — what templates exist and what they emit,
 *   - `buildDocumentationProject()` — validate, confine, then scaffold, with
 *     the same guard rails the wizard has (known template, folder inside the
 *     project, refuse to scribble into a folder that already has content).
 *
 * No template knowledge lives here: the data comes from `docTemplates.ts` and
 * the writer is `scaffoldDocs.ts`, i.e. exactly the code the wizard runs.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DOC_PROJECT_SPECS, DocOptions, DocProjectSpec, selectDocFiles } from './docTemplates';
import { scaffoldDocumentationProject } from './scaffoldDocs';

/** Template ids accepted by `build_documentation`, in wizard order. */
export const DOC_TEMPLATE_IDS: readonly string[] = Object.keys(DOC_PROJECT_SPECS);

/** Files one template emits (before option-dependent filtering is applied). */
export interface DocTemplateFileSummary {
  /** Path relative to the project root, forward slashes. */
  path: string;
  docType: string;
  title: string;
}

export interface DocTemplateSummary {
  templateId: string;
  templateName: string;
  role: string;
  roleCode: string;
  /** How many files the template emits with default options. */
  documentCount: number;
  /** Only present when a single template was asked for. */
  documents?: DocTemplateFileSummary[];
}

export interface DocTemplateCatalog {
  templates: DocTemplateSummary[];
  /** Options accepted by `build_documentation.options`. */
  optionKeys: string[];
}

/**
 * Option names a caller may pass through to the scaffolder. Kept as a short
 * enumeration for the help text — unknown keys are ignored by the scaffolder
 * itself, so this is documentation, not validation.
 */
const DOC_OPTION_KEYS = [
  'governance',
  'docLanguage',
  'docControl',
  'traceability',
  'krisaCompliance',
  'wordExport',
  'xlsxExport',
  'screenshots',
  'diagramTool',
  'captureInputs',
  'includeStakeholders',
  'includeProcess',
  'includeNfr',
  'includeDesign',
  'includeUserDocs',
  'includeRunbooks',
  'includeApiDocs',
  'includeTestCases',
  'includeUat',
  'includeSecurity',
  'includePerformance',
  'defectManagement',
];

function emptyOptions(): DocOptions {
  return {};
}

/**
 * Template catalogue. Without an id it lists all templates; with one it also
 * returns that template's file list, so the agent can plan before building.
 */
export function describeDocTemplates(templateId?: string): DocTemplateCatalog | { error: string } {
  const wanted = String(templateId ?? '').trim();
  if (wanted && !DOC_PROJECT_SPECS[wanted]) {
    return {
      error: `Unknown documentation template '${wanted}'. Available: ${DOC_TEMPLATE_IDS.join(', ')}.`,
    };
  }

  const ids = wanted ? [wanted] : [...DOC_TEMPLATE_IDS];
  const templates: DocTemplateSummary[] = ids.map((id) => {
    const spec = DOC_PROJECT_SPECS[id];
    const files = selectDocFiles(spec, emptyOptions());
    const summary: DocTemplateSummary = {
      templateId: spec.templateId,
      templateName: spec.templateName,
      role: spec.role,
      roleCode: spec.roleCode,
      documentCount: files.length,
    };
    if (wanted) {
      summary.documents = files.map((file) => ({
        path: file.path,
        docType: file.docType,
        title: file.titleEn,
      }));
    }
    return summary;
  });

  return { templates, optionKeys: [...DOC_OPTION_KEYS] };
}

export interface BuildDocumentationRequest {
  /** Absolute path of the open project root. */
  workspaceRoot: string;
  /** `doc-ba` | `doc-writer` | `doc-tester`. */
  templateId: string;
  /** Project name; also the default target folder and the document-id prefix. */
  projectName: string;
  /** Target folder, relative to the project root. Defaults to `projectName`. */
  directory?: string;
  version?: string;
  description?: string;
  options?: Record<string, unknown>;
  /** Allow writing into a folder that already contains files. */
  overwrite?: boolean;
}

export type BuildDocumentationResult =
  | { error: string }
  | { directory: string; created: string[]; warnings: string[]; next: string };

function toPosix(value: string): string {
  return value.split(path.sep).join('/').split('\\').join('/');
}

/**
 * Resolve the target folder inside the project root, refusing absolute paths
 * and anything that escapes it (`..`, symlink-ish tricks are the caller's
 * problem — this is a confinement check, not a sandbox).
 */
function resolveTargetDirectory(
  workspaceRoot: string,
  directory: string
): { absolute: string; relative: string } | { error: string } {
  const root = path.resolve(workspaceRoot);
  if (path.isAbsolute(directory) || /^[A-Za-z]:/.test(directory)) {
    return { error: 'directory must be relative to the project root, not an absolute path.' };
  }
  const absolute = path.resolve(root, directory);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return {
      error: `Refusing to build into '${directory}': it is outside the project root (or is the root itself). Pass a subfolder.`,
    };
  }
  return { absolute, relative: toPosix(relative) };
}

/** Entries already present in the target folder (empty when it does not exist). */
function existingEntries(target: string): string[] {
  try {
    return fs.readdirSync(target);
  } catch {
    return [];
  }
}

/**
 * Build a documentation project: same folder layout, front matter, registers
 * and guidance files the New Project wizard produces, because it is literally
 * the same scaffolder.
 */
export function buildDocumentationProject(
  request: BuildDocumentationRequest
): BuildDocumentationResult {
  const templateId = String(request.templateId ?? '').trim();
  const spec: DocProjectSpec | undefined = DOC_PROJECT_SPECS[templateId];
  if (!spec) {
    return {
      error: `Unknown documentation template '${templateId || '(empty)'}'. Available: ${DOC_TEMPLATE_IDS.join(', ')}.`,
    };
  }

  const projectName = String(request.projectName ?? '').trim();
  if (!projectName) {
    return { error: 'projectName is required (it becomes the document-id prefix).' };
  }

  const directory = String(request.directory ?? '').trim() || projectName;
  const target = resolveTargetDirectory(request.workspaceRoot, directory);
  if ('error' in target) {
    return target;
  }

  const entries = existingEntries(target.absolute);
  if (entries.length > 0 && request.overwrite !== true) {
    return {
      error: `Target folder '${target.relative}' already exists and is not empty (${entries.length} entries). Re-run with overwrite: true to write the document set alongside them, or pick another directory.`,
    };
  }

  const warnings: string[] = [];
  const options: DocOptions = { ...(request.options ?? {}) };
  let created: string[];
  try {
    created = scaffoldDocumentationProject(
      target.absolute,
      {
        templateId: spec.templateId,
        projectName,
        projectDescription: String(request.description ?? '').trim() || `${spec.templateName} documentation project.`,
        projectVersion: String(request.version ?? '').trim() || '0.1.0',
        templateOptions: options as Record<string, unknown>,
        targetPath: target.absolute,
      },
      spec,
      warnings
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Scaffolding failed: ${message}` };
  }

  return {
    directory: target.relative,
    created: created.map(toPosix).sort(),
    warnings,
    next: `Markdown in '${target.relative}' is the source of truth — fill it in with edit_file/write_to_file. Word/XLSX/PNG exports are generated from it by the Documentation Export command, never hand-edited.`,
  };
}
