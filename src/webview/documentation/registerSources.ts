/**
 * Host-side collection of a documentation project's registers.
 *
 * The workbook builder (`shared/documentation/registerWorkbook.ts`) is pure and
 * takes CSV text. This module is the only part that touches disk: it reads
 * `.ado-code/documentation.json` for the project metadata and each register CSV
 * the role owns, then hands plain text to the builder.
 *
 * Policy worth stating, because it decides what a reviewer sees:
 *   - a register whose CSV exists is always included, even when empty;
 *   - a register whose CSV is missing is OMITTED, so a project that deliberately
 *     dropped `document-control` (Minimal rigour) is not nagged about a file it
 *     chose not to have;
 *   - when NO register exists at all, every register the role owns is included
 *     as an empty shell — a workbook of one README sheet teaches nothing.
 */
import * as vscode from 'vscode';
import { REGISTER_SPECS, type RegisterKind, type RegisterSource } from '../../shared/documentation/registerWorkbook';
import type { DocRole } from '../../shared/documentation/krisa';

/** Where the scaffolder records the project's role, framework and options. */
export const DOCUMENTATION_RECORD_PATH = '.ado-code/documentation.json';

export interface DocumentationRecord {
  role?: string;
  project?: string;
  templateId?: string;
  framework?: string;
  language?: string;
  documentVersion?: string;
  xlsxExport?: string;
  classification?: string;
  [key: string]: unknown;
}

export interface CollectedRegisters {
  ok: boolean;
  /** Why collection failed, when `ok` is false. */
  reason?: string;
  role: DocRole;
  projectName: string;
  record: DocumentationRecord;
  sources: RegisterSource[];
  present: RegisterKind[];
  missing: RegisterKind[];
  /** File name the save dialog should start from. */
  suggestedFileName: string;
  warnings: string[];
}

const ROLES: readonly DocRole[] = ['BA', 'Writer', 'Tester'];

export function isDocRole(value: unknown): value is DocRole {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export interface CollectorOptions {
  /** Injected for tests; defaults to `vscode.workspace.fs` (a Thenable, hence PromiseLike). */
  readFile?: (uri: vscode.Uri) => PromiseLike<Uint8Array>;
}

type ReadFn = (uri: vscode.Uri) => PromiseLike<Uint8Array>;

function decode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}

/** Characters a Windows file name cannot contain — including C0 controls. */
// eslint-disable-next-line no-control-regex -- control characters are the target here
const UNSAFE_FILE_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

/** Strips characters that would make a file name unusable on Windows. */
export function workbookFileName(projectName: string): string {
  const cleaned = projectName
    .replace(UNSAFE_FILE_NAME_CHARS, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return `${cleaned || 'documentation'}-registers.xlsx`;
}

async function tryRead(uri: vscode.Uri, read: ReadFn): Promise<string | undefined> {
  try {
    return decode(await Promise.resolve(read(uri)));
  } catch {
    return undefined;
  }
}

/**
 * Reads the documentation record + every register CSV for the project's role.
 *
 * Never throws: a missing record is a `ok: false` result with a reason, because
 * the caller has to show the user something in a toast, not a stack trace.
 */
export async function collectRegisterSources(
  projectRoot: vscode.Uri,
  options: CollectorOptions = {},
): Promise<CollectedRegisters> {
  const read: ReadFn = options.readFile ?? ((uri: vscode.Uri) => vscode.workspace.fs.readFile(uri));
  const join = (relative: string) => vscode.Uri.joinPath(projectRoot, ...relative.split('/'));
  const warnings: string[] = [];

  const rawRecord = await tryRead(join(DOCUMENTATION_RECORD_PATH), read);
  if (rawRecord === undefined) {
    return {
      ok: false,
      reason: `${DOCUMENTATION_RECORD_PATH} was not found — this folder is not a documentation project`,
      role: 'BA',
      projectName: '',
      record: {},
      sources: [],
      present: [],
      missing: REGISTER_SPECS.map((spec) => spec.kind),
      suggestedFileName: workbookFileName(''),
      warnings,
    };
  }

  let record: DocumentationRecord = {};
  try {
    const parsed = JSON.parse(rawRecord) as unknown;
    if (parsed && typeof parsed === 'object') {
      record = parsed as DocumentationRecord;
    } else {
      warnings.push(`${DOCUMENTATION_RECORD_PATH} is not a JSON object — falling back to defaults`);
    }
  } catch {
    warnings.push(`${DOCUMENTATION_RECORD_PATH} is not valid JSON — falling back to defaults`);
  }

  let role: DocRole = 'BA';
  if (isDocRole(record.role)) {
    role = record.role;
  } else {
    warnings.push(`${DOCUMENTATION_RECORD_PATH} has no usable "role" — assuming Business Analysis`);
  }

  const projectName = typeof record.project === 'string' && record.project.trim() !== ''
    ? record.project.trim()
    : projectRoot.path.split('/').filter(Boolean).pop() ?? 'documentation';

  const owned = REGISTER_SPECS.filter((spec) => spec.roles.includes(role));
  const sources: RegisterSource[] = [];
  const present: RegisterKind[] = [];
  const missing: RegisterKind[] = [];

  for (const spec of owned) {
    const csv = await tryRead(join(spec.csvPath), read);
    if (csv === undefined) {
      missing.push(spec.kind);
      continue;
    }
    present.push(spec.kind);
    sources.push({ kind: spec.kind, csv });
  }

  if (sources.length === 0) {
    warnings.push(
      `No register CSV was found in this project — the workbook will contain the ${owned.length} register sheet(s) the ${role} role owns, empty`,
    );
    for (const spec of owned) {
      sources.push({ kind: spec.kind, csv: undefined });
    }
  }

  return {
    ok: true,
    role,
    projectName,
    record,
    sources,
    present,
    missing,
    suggestedFileName: workbookFileName(projectName),
    warnings,
  };
}
