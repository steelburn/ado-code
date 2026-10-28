/**
 * Column contracts for the documentation project registers.
 *
 * Every register exists in three forms and they MUST agree:
 *   - a Markdown table in the .md artefact (rendered into DOCX/HTML/PDF)
 *   - a CSV file (the source of truth, committed, diffable, agent-editable)
 *   - an XLSX sheet (the deliverable, generated from the CSV/Markdown)
 *
 * The three tests in `documentationColumns.test.ts` pin that agreement by
 * asserting the headers are the same strings everywhere. If a column name
 * drifts, the RTM joins (`REQ-###` -> `TEST-CASE`) silently stop matching,
 * which is exactly the failure a KRiSA audit finds and a build should not.
 *
 * Prefix-stable rule: the first columns are join keys and keep fixed
 * positions. Team-specific columns are APPENDED, never inserted.
 *
 * Deliberately vscode-free and DOM-free so it runs under plain mocha and is
 * importable from both the host and the webview bundle.
 */

/** Join columns shared by every documentation project. */
export const RTM_COLUMNS = [
  'REQ-ID',
  'TITLE',
  'SOURCE',
  'ADO-WORK-ITEM',
  'DESIGN-REF',
  'TEST-CASE',
  'UAT-STATUS',
  'STATUS',
] as const;

/** One row per attached file (screenshot, figure, diagram). */
export const MEDIA_COLUMNS = [
  'MEDIA-ID',
  'FILE',
  'KIND',
  'CAPTURED-UTC',
  'HASH-SHA256',
  'CLASSIFICATION',
  'LINKED-ARTEFACT',
  'CAPTION',
  'NOTES',
] as const;
/**
 * One row per RAW SOURCE received to support the documentation: meeting
 * notes, transcripts, workshop output, whiteboard sketches, emails, survey
 * results, source documents supplied by the client.
 *
 * `MEDIA_COLUMNS` records what the finished documents REFERENCE (outbound);
 * this register records what the documents were DERIVED FROM (inbound). The
 * two together close the chain an auditor walks: source -> REQ-### -> TC-###
 * -> EX-#### -> EVD-###.
 */
export const INPUT_COLUMNS = [
  'INPUT-ID',
  'TYPE',
  'RECEIVED-DATE',
  'SOURCE-DATE',
  'FILE',
  'TITLE',
  'FROM',
  'LINKED-DOC',
  'LINKED-REQ',
  'STATUS',
  'CLASSIFICATION',
  'HASH-SHA256',
  'NOTES',
] as const;


/**
 * One row per test EXECUTION attempt (not per file). A single test case
 * routinely needs several screenshots, and a retest needs fresh ones against
 * the same case, so evidence is linked by MEDIA-ID in the `EVIDENCE` column.
 *
 * Column order is deliberate: the four join keys (EXEC-ID, TEST-CASE-ID,
 * REQ-ID, CYCLE) stay in stable leading positions so RTM/evidence joins never
 * break, and team-specific columns are APPENDED at the end rather than
 * inserted in the middle.
 *
 * CYCLE exists because test execution happens in rounds (SIT-1, UAT-1, UAT-2)
 * and sign-off quotes the round, not the build: one round may span two builds,
 * so BUILD-VERSION alone cannot answer "what was the pass rate in UAT round 2".
 */
export const EVIDENCE_COLUMNS = [
  'EXEC-ID',
  'TEST-CASE-ID',
  'REQ-ID',
  'CYCLE',
  'SCENARIO',
  'BUILD-VERSION',
  'ENVIRONMENT',
  'EXECUTED-UTC',
  'EXECUTED-BY',
  'WITNESSED-BY',
  'STEP-REF',
  'EXPECTED',
  'ACTUAL',
  'RESULT',
  'BLOCKED-REASON',
  'DEFECT-ID',
  'RETEST-OF',
  'EVIDENCE',
  'REMARKS',
] as const;

/** Document register: one row per artefact in the project. */
export const DOCUMENT_COLUMNS = [
  'DOC-ID',
  'TITLE',
  'VERSION',
  'STATUS',
  'OWNER',
  'APPROVER',
  'CLASSIFICATION',
  'DELIVERY-FORMAT',
] as const;

/**
 * Fixed vocabularies. Free-text RESULT values ("ok", "pass!", "PASS") are the
 * single most common reason a register cannot be summarised at sign-off, so
 * these are enforced as XLSX dropdowns and documented in the README sheet.
 */
export const RESULT_VALUES = ['Pass', 'Fail', 'Blocked', 'Not Run'] as const;
export const ENVIRONMENT_VALUES = ['DEV', 'SIT', 'UAT', 'STG', 'PROD'] as const;

/**
 * Required when RESULT is `Blocked`, blank otherwise. A blocked execution
 * without a reason is the one thing an auditor will ask about, so the reason is
 * enumerated rather than free text — free text makes "how many were blocked by
 * an environment outage?" unanswerable.
 */
export const BLOCKED_REASON_VALUES = [
  'Environment unavailable',
  'Test data missing',
  'Blocking defect',
  'Access denied',
  'Dependency not delivered',
  'Other',
] as const;
export const CLASSIFICATION_VALUES = ['INTERNAL', 'TERHAD', 'RESTRICTED'] as const;
export const DOC_STATUS_VALUES = ['Draft', 'In Review', 'Approved', 'Superseded'] as const;

/** What kind of raw source an INPUT-ID refers to. */
export const INPUT_TYPE_VALUES = [
  'meeting-notes',
  'transcript',
  'recording',
  'workshop-output',
  'whiteboard-sketch',
  'email',
  'survey',
  'source-document',
  'reference',
  'other',
] as const;

/** How far an input has been worked into the documentation. */
export const INPUT_STATUS_VALUES = [
  'Received',
  'Triaged',
  'Incorporated',
  'Superseded',
  'Rejected',
] as const;

/** Excel on a BM/UTF-8 locale mangles non-ASCII without this. */
export const UTF8_BOM = '\uFEFF';

/** Headers are compared byte-for-byte between template roles. */
export function csvHeader(columns: readonly string[]): string {
  return columns.join(',');
}

function escapeCsvCell(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  const text = typeof value === 'string' ? value : String(value);
  // Leading/trailing spaces are meaningful in a register, so they force quoting
  // rather than being trimmed (trimming would silently corrupt a caption).
  const needsQuote =
    text.includes(',') ||
    text.includes('"') ||
    text.includes('\n') ||
    text.includes('\r') ||
    text !== text.trim();
  return needsQuote ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Render one row. Short rows are padded and long rows truncated to the column
 * count so a malformed row can never shift every later value into the wrong
 * column — a corrupt register is worse than a lossy one.
 */
export function csvRow(
  values: readonly unknown[],
  columnCount?: number
): string {
  const width = columnCount ?? values.length;
  const cells: string[] = [];
  for (let i = 0; i < width; i++) {
    cells.push(escapeCsvCell(values[i]));
  }
  return cells.join(',');
}

export interface CsvOptions {
  /** Prefix the byte-order mark so Excel opens UTF-8 correctly. Default true. */
  bom?: boolean;
  /** Newline. Default CRLF (Excel-native). */
  eol?: '\n' | '\r\n';
}

/** Full CSV document: header + rows. */
export function toCsv(
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
  options: CsvOptions = {}
): string {
  const eol = options.eol ?? '\r\n';
  const lines = [csvHeader(columns)];
  for (const row of rows) {
    lines.push(csvRow(row, columns.length));
  }
  const body = lines.join(eol) + eol;
  return (options.bom ?? true) ? UTF8_BOM + body : body;
}

/** Markdown pipe-table header + separator, from the same column list. */
export function markdownTableHeader(columns: readonly string[]): string[] {
  return [
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
  ];
}
