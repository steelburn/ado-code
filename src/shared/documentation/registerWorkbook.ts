/**
 * Registers -> XLSX workbook projection for documentation projects.
 *
 * The CSV files in the project tree are the source of truth: committed,
 * diffable, reviewable in a pull request and editable by the agent. The
 * workbook is GENERATED from them and is never maintained in parallel — a
 * binary form in git has no diff, no merge, and the agent cannot edit it, so
 * letting the spreadsheet become authoritative would end the audit trail.
 *
 * Layout is derived from `columns.ts` rather than restated here: a column the
 * contract defines but this module forgot to map would be a silent hole in the
 * deliverable, so the sheet headers are asserted to equal the CSV headers.
 *
 * No `vscode`, no DOM, no dependencies — the webview passes the ZIP function.
 */
import {
  CLASSIFICATION_VALUES,
  DOCUMENT_COLUMNS,
  DOC_STATUS_VALUES,
  ENVIRONMENT_VALUES,
  BLOCKED_REASON_VALUES,
  EVIDENCE_COLUMNS,
  INPUT_COLUMNS,
  INPUT_STATUS_VALUES,
  INPUT_TYPE_VALUES,
  MEDIA_COLUMNS,
  RESULT_VALUES,
  RTM_COLUMNS,
} from './columns';
import type { DocRole } from './krisa';
import { infoSheet } from '../xlsx';
import type {
  XlsxCellValue,
  XlsxColumn,
  XlsxColumnType,
  XlsxLink,
  XlsxSheet,
  XlsxWorkbook,
} from '../xlsx';

// ---------------------------------------------------------------------------
// CSV reading
// ---------------------------------------------------------------------------

export interface ParsedCsv {
  header: string[];
  rows: string[][];
  warnings: string[];
}

/** Rows longer than the header are truncated; this counts how many. */
const EMPTY_CSV: ParsedCsv = { header: [], rows: [], warnings: [] };

/**
 * RFC 4180-style CSV reader, tolerant on purpose.
 *
 * The registers are written by this extension but edited by humans in Excel and
 * by the agent, so the reader must survive a quoted field containing a comma, a
 * newline, a doubled quote, a UTF-8 BOM (Excel writes one) and CRLF endings.
 * Anything it cannot represent is reported rather than dropped silently.
 */
export function parseCsv(source: string): ParsedCsv {
  const text = source.replace(/^\uFEFF/, '');
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === ',') {
      record.push(field);
      field = '';
      index += 1;
      continue;
    }
    if (char === '\r') {
      // CRLF is normalised; a bare CR ends the record too.
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      index += text[index + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (char === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }

  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  const meaningful = records.filter((cells) => cells.some((cell) => cell.trim() !== ''));
  if (meaningful.length === 0) {
    return { ...EMPTY_CSV, warnings: [] };
  }

  const header = meaningful[0].map((cell) => cell.trim());
  const rows: string[][] = [];
  let overflow = 0;

  for (const cells of meaningful.slice(1)) {
    if (cells.length > header.length) {
      overflow += 1;
    }
    const trimmed = cells.slice(0, header.length);
    while (trimmed.length < header.length) {
      trimmed.push('');
    }
    rows.push(trimmed);
  }

  const warnings =
    overflow > 0
      ? [`${overflow} row(s) had more cells than the header — the extra cells were dropped`]
      : [];

  return { header, rows, warnings };
}

// ---------------------------------------------------------------------------
// Column metadata
// ---------------------------------------------------------------------------

export interface ColumnMeta {
  type: XlsxColumnType;
  values?: readonly string[];
  width?: number;
}

const text = (width = 24): ColumnMeta => ({ type: 'text', width });
const enumerated = (values: readonly string[], width = 13): ColumnMeta => ({
  type: 'enum',
  values: [...values],
  width,
});
const datetime = (width = 17): ColumnMeta => ({ type: 'datetime', width });
const date = (width = 13): ColumnMeta => ({ type: 'date', width });

/**
 * Header -> cell behaviour, shared by every register.
 *
 * A header that appears in more than one register with different vocabularies
 * (`STATUS`) is resolved by the per-register `overrides` below — never by
 * guessing here, because a wrong dropdown silently rewrites the meaning of a
 * column.
 */
const COLUMN_META: Record<string, ColumnMeta> = {
  // Requirement traceability
  'REQ-ID': text(12),
  TITLE: text(40),
  SOURCE: text(22),
  'ADO-WORK-ITEM': text(15),
  'DESIGN-REF': text(18),
  'TEST-CASE': text(18),
  'UAT-STATUS': enumerated(RESULT_VALUES, 12),

  // Media register
  'MEDIA-ID': text(12),
  FILE: text(34),
  KIND: enumerated(['evidence', 'figure', 'diagram'], 11),
  'CAPTURED-UTC': datetime(),
  'HASH-SHA256': text(20),
  CLASSIFICATION: enumerated(CLASSIFICATION_VALUES, 14),
  'LINKED-ARTEFACT': text(18),
  CAPTION: text(34),
  NOTES: text(34),

  // Source inputs
  'INPUT-ID': text(11),
  TYPE: enumerated(INPUT_TYPE_VALUES, 18),
  'RECEIVED-DATE': date(),
  'SOURCE-DATE': date(),
  FROM: text(22),
  'LINKED-DOC': text(18),
  'LINKED-REQ': text(18),

  // Test evidence
  'EXEC-ID': text(11),
  'TEST-CASE-ID': text(14),
  CYCLE: text(12),
  SCENARIO: text(34),
  'BUILD-VERSION': text(16),
  ENVIRONMENT: enumerated(ENVIRONMENT_VALUES, 12),
  'EXECUTED-UTC': datetime(),
  'EXECUTED-BY': text(15),
  'WITNESSED-BY': text(15),
  'STEP-REF': text(10),
  EXPECTED: text(30),
  ACTUAL: text(30),
  RESULT: enumerated(RESULT_VALUES, 11),
  'BLOCKED-REASON': enumerated(BLOCKED_REASON_VALUES, 26),
  'DEFECT-ID': text(11),
  'RETEST-OF': text(11),
  EVIDENCE: text(32),
  REMARKS: text(30),

  // Document register
  'DOC-ID': text(20),
  VERSION: text(9),
  OWNER: text(18),
  APPROVER: text(18),
  'DELIVERY-FORMAT': text(22),

  // Ambiguous by default: every register overrides it. `text` here only
  // matters if someone adds a register without an override.
  STATUS: text(12),
};

// ---------------------------------------------------------------------------
// Register specifications
// ---------------------------------------------------------------------------

export type RegisterKind = 'documents' | 'rtm' | 'media' | 'evidence' | 'inputs';

export interface RegisterSpec {
  kind: RegisterKind;
  /** Path inside the project, matching the scaffolder. */
  csvPath: string;
  sheetName: string;
  columns: readonly string[];
  /** Roles whose project contains this register. */
  roles: readonly DocRole[];
  overrides?: Record<string, ColumnMeta>;
  /** Columns whose cell opens the referenced file. */
  linkColumns?: readonly string[];
}

export const REGISTER_SPECS: readonly RegisterSpec[] = [
  {
    kind: 'documents',
    csvPath: '00-project-control/document-register.csv',
    sheetName: 'Documents',
    columns: DOCUMENT_COLUMNS,
    roles: ['BA', 'Writer', 'Tester'],
    overrides: { STATUS: enumerated(DOC_STATUS_VALUES, 12) },
  },
  {
    kind: 'rtm',
    csvPath: '05-traceability/rtm.csv',
    sheetName: 'RTM',
    columns: RTM_COLUMNS,
    roles: ['BA', 'Writer', 'Tester'],
    overrides: { STATUS: enumerated(DOC_STATUS_VALUES, 12) },
  },
  {
    kind: 'media',
    csvPath: 'assets/media-register.csv',
    sheetName: 'Media',
    columns: MEDIA_COLUMNS,
    roles: ['BA', 'Writer', 'Tester'],
    linkColumns: ['FILE'],
  },
  {
    kind: 'inputs',
    csvPath: 'inputs/source-register.csv',
    sheetName: 'Inputs',
    columns: INPUT_COLUMNS,
    roles: ['BA', 'Writer', 'Tester'],
    overrides: { STATUS: enumerated(INPUT_STATUS_VALUES, 13) },
    linkColumns: ['FILE'],
  },
  {
    kind: 'evidence',
    csvPath: '04-defects/test-evidence-register.csv',
    sheetName: 'Test evidence',
    columns: EVIDENCE_COLUMNS,
    roles: ['Tester'],
    linkColumns: ['EVIDENCE'],
  },
] as const;

export function registerSpec(kind: RegisterKind): RegisterSpec | undefined {
  return REGISTER_SPECS.find((spec) => spec.kind === kind);
}

function metaFor(spec: RegisterSpec, header: string): ColumnMeta {
  return spec.overrides?.[header] ?? COLUMN_META[header] ?? text();
}

// ---------------------------------------------------------------------------
// Cell coercion
// ---------------------------------------------------------------------------

/**
 * Aggregates diagnostics instead of emitting one per row: a register where
 * someone typed `PASS` fifty times must produce ONE warning naming the count
 * and a sample, not fifty that bury everything else in the toast.
 */
interface WarningSink {
  add(key: string, sample: string): void;
  drain(): string[];
}

function warningSink(): WarningSink {
  const buckets = new Map<string, { count: number; samples: string[] }>();
  return {
    add(key, sample) {
      const bucket = buckets.get(key) ?? { count: 0, samples: [] };
      bucket.count += 1;
      if (sample && bucket.samples.length < 2 && !bucket.samples.includes(sample)) {
        bucket.samples.push(sample);
      }
      buckets.set(key, bucket);
    },
    drain() {
      const messages: string[] = [];
      for (const [key, bucket] of buckets) {
        const sample = bucket.samples.length > 0 ? ` (e.g. ${bucket.samples.map((s) => JSON.stringify(s)).join(', ')})` : '';
        messages.push(`${key}: ${bucket.count} value(s)${sample}`);
      }
      return messages;
    },
  };
}

const INVALID_DATE = 'INVALID';

/** Accepts `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM[:SS][Z]` and `YYYY-MM-DD HH:MM[:SS]`. */
export function parseIsoDate(value: string, withTime: boolean): Date | string {
  const trimmed = value.trim();
  if (trimmed === '') {
    return '';
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(trimmed);
  if (!match) {
    return INVALID_DATE;
  }
  const [, y, m, d, hh, mm, ss] = match;
  const parsed = new Date(Date.UTC(
    Number(y),
    Number(m) - 1,
    Number(d),
    withTime ? Number(hh ?? 0) : 0,
    withTime ? Number(mm ?? 0) : 0,
    withTime ? Number(ss ?? 0) : 0,
  ));
  if (Number.isNaN(parsed.getTime())) {
    return INVALID_DATE;
  }
  // Reject 2026-13-45, which Date.UTC happily rolls over into next year.
  if (parsed.getUTCFullYear() !== Number(y) || parsed.getUTCMonth() !== Number(m) - 1 || parsed.getUTCDate() !== Number(d)) {
    return INVALID_DATE;
  }
  return parsed;
}

const FILE_LIKE = /^(?:\.{0,2}\/)?[\w][\w./ -]*\.(?:png|jpe?g|gif|svg|webp|bmp|pdf|txt|md|csv|xlsx|docx|mp3|mp4|wav|m4a|mov|mkv|webm)$/i;

/**
 * Builds the workbook-relative hyperlink for a project file.
 *
 * The workbook is written to `export/out/`, so a project file needs one `../../`
 * prefix. A bare id (`EVD-001`) is NOT a path and stays plain text — inventing a
 * target for it would produce a link that opens nothing.
 */
export function linkHref(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.includes(',') || !FILE_LIKE.test(trimmed)) {
    return undefined;
  }
  const normalised = trimmed.replace(/^\.\//, '').replace(/^\.\.\//, '');
  return `../../${normalised}`;
}

function toCell(
  raw: string,
  meta: ColumnMeta,
  header: string,
  link: boolean,
  sink: WarningSink,
): XlsxCellValue {
  const value = raw.trim();
  if (value === '') {
    return undefined;
  }
  switch (meta.type) {
    case 'enum': {
      if (meta.values && !meta.values.includes(value)) {
        sink.add(`${header} outside its vocabulary`, value);
      }
      return value;
    }
    case 'date':
    case 'datetime': {
      const parsed = parseIsoDate(value, meta.type === 'datetime');
      if (parsed === INVALID_DATE) {
        sink.add(`${header} is not an ISO-8601 ${meta.type === 'datetime' ? 'date-time' : 'date'} (kept as text)`, value);
        return value;
      }
      return parsed;
    }
    case 'number': {
      const numeric = Number(value.replace(/,/g, ''));
      if (!Number.isFinite(numeric)) {
        sink.add(`${header} is not numeric (kept as text)`, value);
        return value;
      }
      return numeric;
    }
    default: {
      if (link) {
        const href = linkHref(value);
        if (href) {
          const cell: XlsxLink = { text: value, href };
          return cell;
        }
      }
      return value;
    }
  }
}

// ---------------------------------------------------------------------------
// Sheet construction
// ---------------------------------------------------------------------------

function columnsFor(spec: RegisterSpec, header: readonly string[]): XlsxColumn[] {
  const columns: XlsxColumn[] = spec.columns.map((name) => {
    const meta = metaFor(spec, name);
    return { header: name, type: meta.type, width: meta.width, values: meta.values as string[] | undefined };
  });
  for (const extra of header) {
    if (!spec.columns.includes(extra)) {
      columns.push({ header: extra, type: 'text', width: Math.max(12, Math.min(40, extra.length + 4)) });
    }
  }
  return columns;
}

interface BuiltRegister {
  sheet: XlsxSheet;
  rows: number;
  cells: XlsxCellValue[][];
  /** Index of a header inside the sheet, or -1. */
  indexOf(header: string): number;
}

function buildRegisterSheet(
  spec: RegisterSpec,
  csv: string | undefined,
  sink: WarningSink,
  warnings: string[],
): BuiltRegister {
  const parsed = csv === undefined ? EMPTY_CSV : parseCsv(csv);
  for (const warning of parsed.warnings) {
    warnings.push(`${spec.sheetName}: ${warning}`);
  }

  if (csv === undefined) {
    warnings.push(`${spec.csvPath} was not found — the "${spec.sheetName}" sheet was generated empty`);
  }

  const header = parsed.header;
  const missing = spec.columns.filter((name) => !header.includes(name));
  const extra = header.filter((name) => !(spec.columns as readonly string[]).includes(name));
  if (header.length > 0) {
    if (missing.length > 0) {
      warnings.push(`${spec.sheetName}: column(s) missing from ${spec.csvPath}: ${missing.join(', ')}`);
    }
    if (extra.length > 0) {
      warnings.push(`${spec.sheetName}: column(s) not in the contract, appended at the end: ${extra.join(', ')}`);
    }
  }

  const columns = columnsFor(spec, header);
  const position = new Map<string, number>();
  header.forEach((name, index) => position.set(name, index));

  const cells: XlsxCellValue[][] = parsed.rows.map((row) =>
    columns.map((column) => {
      const sourceIndex = position.get(column.header);
      if (sourceIndex === undefined) {
        return undefined;
      }
      const meta = metaFor(spec, column.header);
      const link = (spec.linkColumns ?? []).includes(column.header);
      const cell = toCell(row[sourceIndex] ?? '', meta, column.header, link, sink);
      if (typeof cell === 'string' && cell === '') {
        return undefined;
      }
      return cell;
    }),
  );

  const sheet: XlsxSheet = {
    name: spec.sheetName,
    columns,
    rows: cells,
    freezeHeader: true,
    autoFilter: cells.length > 0,
  };

  return {
    sheet,
    rows: cells.length,
    cells,
    indexOf: (name: string) => columns.findIndex((column) => column.header === name),
  };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export interface SummaryLine {
  label: string;
  value: string | number;
}

function countValues(register: BuiltRegister | undefined, header: string, wanted: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  if (!register) {
    return counts;
  }
  const index = register.indexOf(header);
  if (index < 0) {
    return counts;
  }
  for (const row of register.cells) {
    const cell = row[index];
    const value = typeof cell === 'string' ? cell.trim() : '';
    if (!wanted.includes(value)) {
      continue;
    }
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function filled(register: BuiltRegister | undefined, header: string): number {
  if (!register) {
    return 0;
  }
  const index = register.indexOf(header);
  if (index < 0) {
    return 0;
  }
  return register.cells.filter((row) => {
    const cell = row[index];
    return cell !== undefined && cell !== null && cell !== '';
  }).length;
}

export function summariseRegisters(registers: Partial<Record<RegisterKind, BuiltRegister>>): SummaryLine[] {
  const lines: SummaryLine[] = [];
  const { rtm, evidence, media, inputs } = registers;

  if (rtm) {
    const total = rtm.rows;
    const ado = filled(rtm, 'ADO-WORK-ITEM');
    const covered = filled(rtm, 'TEST-CASE');
    const uat = countValues(rtm, 'UAT-STATUS', RESULT_VALUES);
    const passed = uat.get('Pass') ?? 0;
    lines.push(
      { label: 'Requirements tracked', value: total },
      { label: 'Requirements linked to a work item', value: ado },
      { label: 'Requirements with a test case', value: covered },
      {
        label: 'Requirements with a test case (%)',
        value: total === 0 ? 0 : Math.round((covered / total) * 100),
      },
      { label: 'Requirements UAT-passed', value: passed },
    );
  }

  if (evidence) {
    const results = countValues(evidence, 'RESULT', RESULT_VALUES);
    const executions = evidence.rows;
    const withEvidence = filled(evidence, 'EVIDENCE');
    const failures = results.get('Fail') ?? 0;
    const failuresEvidenced = evidence.cells.filter((row) => {
      const resultIndex = evidence.indexOf('RESULT');
      const evidenceIndex = evidence.indexOf('EVIDENCE');
      const result = resultIndex >= 0 ? row[resultIndex] : undefined;
      const attach = evidenceIndex >= 0 ? row[evidenceIndex] : undefined;
      return result === 'Fail' && attach !== undefined && attach !== '';
    }).length;

    lines.push(
      { label: 'Test executions recorded', value: executions },
      { label: 'Executions passed', value: results.get('Pass') ?? 0 },
      { label: 'Executions failed', value: failures },
      { label: 'Executions blocked', value: results.get('Blocked') ?? 0 },
      { label: 'Executions not run', value: results.get('Not Run') ?? 0 },
      { label: 'Executions with evidence attached', value: withEvidence },
      {
        label: 'Executions with evidence attached (%)',
        value: executions === 0 ? 0 : Math.round((withEvidence / executions) * 100),
      },
      { label: 'Failures without evidence', value: Math.max(0, failures - failuresEvidenced) },
    );
  }

  if (media) {
    const total = media.rows;
    const hashes = filled(media, 'HASH-SHA256');
    lines.push(
      { label: 'Media files registered', value: total },
      { label: 'Media files with a SHA-256', value: hashes },
      { label: 'Media files missing a SHA-256', value: Math.max(0, total - hashes) },
    );
  }

  if (inputs) {
    const statuses = countValues(inputs, 'STATUS', INPUT_STATUS_VALUES);
    const total = inputs.rows;
    const incorporated = statuses.get('Incorporated') ?? 0;
    lines.push(
      { label: 'Source inputs received', value: total },
      { label: 'Inputs incorporated', value: incorporated },
      { label: 'Inputs outstanding', value: Math.max(0, total - incorporated - (statuses.get('Superseded') ?? 0) - (statuses.get('Rejected') ?? 0)) },
    );
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Workbook
// ---------------------------------------------------------------------------

export interface RegisterSource {
  kind: RegisterKind;
  /** CSV text, or `undefined` when the file is absent from the project. */
  csv?: string;
}

export interface RegisterWorkbookInput {
  projectName: string;
  role: DocRole;
  templateName?: string;
  version?: string;
  framework?: string;
  language?: string;
  generatedAt?: Date;
  registers: RegisterSource[];
}

export interface RegisterWorkbookResult {
  workbook: XlsxWorkbook;
  warnings: string[];
  sheets: Array<{ kind: RegisterKind | 'summary'; name: string; rows: number }>;
  summary: SummaryLine[];
}

const ROLE_LABEL: Record<DocRole, string> = {
  BA: 'Business Analysis',
  Writer: 'IT Documentation',
  Tester: 'Test & UAT',
};

/**
 * Builds the workbook for a documentation project.
 *
 * Every register the role owns gets a sheet even when its CSV is missing: an
 * empty sheet with the contract headers (and its dropdowns) still tells the
 * tester what to fill in, whereas a missing sheet reads as a broken export.
 */
export function buildRegisterWorkbook(input: RegisterWorkbookInput): RegisterWorkbookResult {
  const generatedAt = input.generatedAt ?? new Date();
  const sources = new Map<RegisterKind, string | undefined>();
  for (const source of input.registers) {
    sources.set(source.kind, source.csv);
  }

  const sink = warningSink();
  const warnings: string[] = [];
  const built: Partial<Record<RegisterKind, BuiltRegister>> = {};
  const sheets: XlsxSheet[] = [];
  const index: RegisterWorkbookResult['sheets'] = [];

  const info = infoSheet({
    name: 'README',
    title: `${input.projectName} — registers`,
    generatedAt,
    fields: [
      ['Project', input.projectName],
      ['Role', ROLE_LABEL[input.role]],
      ['Template', input.templateName ?? '—'],
      ['Version', input.version ?? '—'],
      ['Governance', input.framework ?? 'Standard'],
      ['Language', input.language ?? 'English'],
    ],
    notes: [
      'Generated from the CSV registers in this project — do not edit this workbook and treat it as the source.',
      'The CSV files are authoritative: they are committed, reviewable and editable by the assistant.',
      'Regenerate this workbook after changing a register; edits made here are not read back.',
      `Generated at (UTC) ${generatedAt.toISOString()}`,
    ],
  });
  sheets.push(info);

  for (const spec of REGISTER_SPECS) {
    if (!spec.roles.includes(input.role)) {
      continue;
    }
    const hasSource = sources.has(spec.kind);
    if (!hasSource) {
      continue;
    }
    const register = buildRegisterSheet(spec, sources.get(spec.kind), sink, warnings);
    built[spec.kind] = register;
    sheets.push(register.sheet);
    index.push({ kind: spec.kind, name: register.sheet.name, rows: register.rows });
  }

  for (const warning of sink.drain()) {
    warnings.push(warning);
  }

  const summary = summariseRegisters(built);
  const wantsSummary =
    summary.length > 0 &&
    (input.role === 'Tester' || built.rtm !== undefined || built.media !== undefined || built.inputs !== undefined);
  if (wantsSummary) {
    sheets.push({
      name: 'Summary',
      columns: [
        { header: 'Metric', type: 'text', width: 38 },
        { header: 'Value', type: 'number', width: 12 },
      ],
      rows: summary.map((line) => [line.label, line.value] as XlsxCellValue[]),
      freezeHeader: true,
    });
    index.push({ kind: 'summary', name: 'Summary', rows: summary.length });
  }

  if (index.length === 0) {
    warnings.push('No registers were found for this project — the workbook contains only the README sheet');
  }

  return {
    workbook: {
      title: `${input.projectName} — registers`,
      creator: 'ADO Code',
      subject: `Documentation registers (${ROLE_LABEL[input.role]})`,
      generatedAt,
      sheets,
    },
    warnings,
    sheets: index,
    summary,
  };
}
