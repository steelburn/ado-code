/**
 * xlsx — a dependency-free SpreadsheetML (`.xlsx`) writer.
 *
 * The documentation templates ship their registers as CSV (the mergeable,
 * diffable, agent-editable source of truth) and hand testers a workbook built
 * from those same rows. This module owns the second half: a workbook model, the
 * OOXML parts derived from it, and the archive assembly.
 *
 * Why hand-rolled rather than `exceljs`/`sheetjs`:
 *   - `fflate` is already in the webview bundle because `docx` depends on it, so
 *     a ZIP of XML costs one lazy chunk that shares that layer and no second
 *     heavy dependency;
 *   - the writer must guarantee ONE invariant that generated spreadsheets
 *     routinely break (see below), which is far easier to prove in code we own;
 *   - no extra licence surface.
 *
 * THE INVARIANT: a cell must never be a `<f>` formula without a cached `<v>`.
 * A formula with no cached value renders as an EMPTY cell in every viewer that
 * does not recalculate (previews, several LibreOffice configurations, Excel's
 * own preview pane). This writer therefore never emits `<f>` at all: the caller
 * computes the value in TS and the serialiser writes the literal. Summary
 * sheets carry real numbers, so they read correctly everywhere.
 *
 * Everything here is pure (no `vscode`, no DOM, no `fflate`): the ZIP step is
 * injected, exactly like the mermaid rasteriser's DOM step, so the whole
 * workbook can be asserted headlessly.
 */

import { parseInline, runsToText, type DocBlock } from './docBlocks';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** SpreadsheetML hard limits (Excel refuses to open past these). */
export const XLSX_MAX_ROWS = 1_048_576;
export const XLSX_MAX_COLUMNS = 16_384;
export const XLSX_MAX_CELL_CHARS = 32_767;
export const XLSX_MAX_SHEET_NAME = 31;

/**
 * Excel's calendar starts at the fictional 1900-01-00, i.e. serial 1 is
 * 1900-01-01 and serial 60 is the non-existent 1900-02-29. Anchoring on
 * 1899-12-30 reproduces that off-by-one for every date at or after 1900-03-01,
 * which is the only range any of these registers uses.
 */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL_TYPE = {
  officeDocument: `${NS_REL}/officeDocument`,
  worksheet: `${NS_REL}/worksheet`,
  styles: `${NS_REL}/styles`,
  sharedStrings: `${NS_REL}/sharedStrings`,
  hyperlink: `${NS_REL}/hyperlink`,
  coreProperties: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
  extendedProperties: `${NS_REL}/extended-properties`,
};

/** Custom number-format ids; anything >= 164 is available for our own formats. */
const NUMFMT_DATETIME = 164;
const NUMFMT_DATE = 165;
const FORMAT_DATETIME = 'yyyy-mm-dd hh:mm';
const FORMAT_DATE = 'yyyy-mm-dd';

/**
 * `cellXfs` indices. Kept deliberately small: one header style, one body style,
 * the two date formats, and a hyperlink style. Every data cell carries a border
 * and top-aligned wrapped text, because a register read on screen is the whole
 * point of the export.
 */
export const STYLE_DEFAULT = 0;
export const STYLE_HEADER = 1;
export const STYLE_BODY = 2;
export const STYLE_DATETIME = 3;
export const STYLE_DATE = 4;
export const STYLE_LINK = 5;

/** Default column widths by type, in Excel character units. */
const DEFAULT_WIDTH: Record<XlsxColumnType, number> = {
  text: 24,
  number: 12,
  date: 14,
  datetime: 20,
  boolean: 10,
  enum: 16,
};

/** Extra rows a dropdown covers beyond the data, so appended rows stay validated. */
const DEFAULT_VALIDATION_EXTRA_ROWS = 200;

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type XlsxColumnType = 'text' | 'number' | 'date' | 'datetime' | 'boolean' | 'enum';

/**
 * A hyperlink delivered as the cell's text plus a target. `href` is written
 * verbatim into the sheet relationships, so it must be a path RELATIVE TO THE
 * WORKBOOK FILE — the registers land in `export/out/`, so a project asset is
 * `../../assets/evidence/EVD-001.png`.
 */
export interface XlsxLink {
  text: string;
  href?: string;
}

export type XlsxCellValue = string | number | boolean | Date | XlsxLink | null | undefined;

export interface XlsxColumn {
  /** Column header text, written verbatim into row 1. */
  header: string;
  /** Drives width, style, and how cell values are coerced. Defaults to `text`. */
  type?: XlsxColumnType;
  /** Override the type's default width (Excel character units). */
  width?: number;
  /**
   * For `type: 'enum'` — the vocabulary behind the dropdown. Rendered as an
   * inline list, so it must stay within Excel's 255-character limit.
   */
  values?: string[];
}

export interface XlsxSheet {
  name: string;
  columns: XlsxColumn[];
  rows: XlsxCellValue[][];
  /** Freeze row 1. Defaults to true. */
  freezeHeader?: boolean;
  /** Filter buttons on the header row. Defaults to true when there is >1 column. */
  autoFilter?: boolean;
  /** Rows of dropdown coverage past the last data row. Defaults to 200. */
  validationExtraRows?: number;
}

export interface XlsxWorkbook {
  title?: string;
  creator?: string;
  subject?: string;
  /** Workbook timestamp; also written to `docProps/core.xml`. Defaults to epoch-free "now". */
  generatedAt?: Date;
  sheets: XlsxSheet[];
}

export type XlsxWarningCode =
  | 'empty-workbook'
  | 'empty-sheet'
  | 'sheet-name-fixed'
  | 'sheet-name-deduped'
  | 'row-overflow'
  | 'column-overflow'
  | 'cell-truncated'
  | 'invalid-number'
  | 'validation-too-long'
  | 'validation-unsupported-chars'
  | 'invalid-date';

export interface XlsxWarning {
  code: XlsxWarningCode;
  message: string;
  sheet?: string;
  row?: number;
  column?: string;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Drops code points that are illegal in XML 1.0. A single stray control
 * character — a NUL or a vertical tab pasted out of a terminal — makes Excel
 * report "unreadable content" and offer to repair the file, which reads to the
 * user as a corrupt export.
 */
export function stripInvalidXmlChars(text: string): string {
  if (!text) {
    return '';
  }
  return text.replace(LONE_SURROGATE, '').replace(INVALID_XML_CHARS, '');
}

export function escapeXml(text: string): string {
  return stripInvalidXmlChars(String(text))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 1-based column index to its spreadsheet letter (`1` → `A`, `27` → `AA`). */
export function columnLetter(index: number): string {
  if (!Number.isFinite(index) || index < 1) {
    return 'A';
  }
  let remaining = Math.floor(index);
  let out = '';
  while (remaining > 0) {
    const digit = (remaining - 1) % 26;
    out = String.fromCharCode(65 + digit) + out;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return out;
}

/** Inverse of {@link columnLetter}. */
export function columnIndex(letters: string): number {
  let out = 0;
  for (const char of String(letters).toUpperCase()) {
    const value = char.charCodeAt(0) - 64;
    if (value < 1 || value > 26) {
      continue;
    }
    out = out * 26 + value;
  }
  return out;
}

export interface SerialDate {
  serial: number;
  /** True when the value carries a time of day, i.e. it needs the datetime format. */
  hasTime: boolean;
}

/**
 * Converts a `Date` to an Excel serial (whole part = day, fraction = time).
 *
 * UTC fields are read deliberately: every date in these registers is an
 * ISO-8601 `…Z` instant (`CAPTURED-UTC`, `EXECUTED-UTC`), so the UTC calendar
 * day is the one the column means, and the conversion cannot drift with the
 * machine's time zone.
 */
export function dateToSerial(value: Date): SerialDate {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    return { serial: 0, hasTime: false };
  }
  const hours = value.getUTCHours();
  const minutes = value.getUTCMinutes();
  const seconds = value.getUTCSeconds();
  const millis = value.getUTCMilliseconds();
  const dayMs = Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
  const fraction = (hours * 3600 + minutes * 60 + seconds + millis / 1000) / 86_400;
  const serial = (dayMs - EXCEL_EPOCH_MS) / 86_400_000 + fraction;
  // Excel stops being reliable past microsecond precision.
  return {
    serial: Math.round(serial * 1e6) / 1e6,
    hasTime: hours !== 0 || minutes !== 0 || seconds !== 0 || millis !== 0,
  };
}

/** UTF-8 encoder. Written out rather than borrowed so no Node/DOM global is required. */
export function utf8Encode(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 without `btoa`/`Buffer`, so the same code runs in host and webview. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  const length = bytes.length;
  for (let i = 0; i < length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < length ? bytes[i + 1] : 0;
    const b2 = i + 2 < length ? bytes[i + 2] : 0;
    out += BASE64_ALPHABET[b0 >> 2];
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < length ? BASE64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < length ? BASE64_ALPHABET[b2 & 0x3f] : '=';
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared strings
// ---------------------------------------------------------------------------

/**
 * Dedupe table for `<si>` entries. Registers repeat a handful of values
 * (`UAT`, `Pass`, a tester's name) thousands of times, and every text cell
 * would otherwise carry its own copy.
 */
class SharedStrings {
  private readonly ids = new Map<string, number>();
  private readonly items: string[] = [];
  private references = 0;

  add(text: string): number {
    this.references += 1;
    const existing = this.ids.get(text);
    if (existing !== undefined) {
      return existing;
    }
    const id = this.items.length;
    this.items.push(text);
    this.ids.set(text, id);
    return id;
  }

  toXml(): string {
    const entries = this.items
      .map((text) => {
        // `xml:space="preserve"` is required or Excel trims leading/trailing spaces.
        const needsPreserve = text !== text.trim();
        return needsPreserve
          ? `<si><t xml:space="preserve">${escapeXml(text)}</t></si>`
          : `<si><t>${escapeXml(text)}</t></si>`;
      })
      .join('');
    return (
      `${XML_DECL}<sst xmlns="${NS_MAIN}" count="${this.references}" ` +
      `uniqueCount="${this.items.length}">${entries}</sst>`
    );
  }
}

// ---------------------------------------------------------------------------
// Cell coercion
// ---------------------------------------------------------------------------

type NormalisedCell =
  | { kind: 'empty' }
  | { kind: 'text'; text: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'date'; serial: number; hasTime: boolean }
  | { kind: 'link'; text: string; href?: string };

interface CellContext {
  sheet: string;
  /** 1-based spreadsheet row, for warnings. */
  row: number;
  column: string;
  warnings: XlsxWarning[];
}

function isLink(value: unknown): value is XlsxLink {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Date) &&
    typeof (value as XlsxLink).text === 'string'
  );
}

function truncateCell(text: string, context: CellContext): string {
  if (text.length <= XLSX_MAX_CELL_CHARS) {
    return text;
  }
  context.warnings.push({
    code: 'cell-truncated',
    message: `${context.sheet}!${context.column}${context.row}: ${text.length} characters exceeds Excel's ${XLSX_MAX_CELL_CHARS}-cell limit; truncated`,
    sheet: context.sheet,
    row: context.row,
    column: context.column,
  });
  return text.slice(0, XLSX_MAX_CELL_CHARS);
}

/** Coerces one model value into the shape its column asks for. */
function normaliseCell(value: XlsxCellValue, column: XlsxColumn, context: CellContext): NormalisedCell {
  if (value === null || value === undefined) {
    return { kind: 'empty' };
  }

  const type = column.type ?? 'text';

  if (isLink(value)) {
    return { kind: 'link', text: truncateCell(String(value.text), context), href: value.href };
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      context.warnings.push({
        code: 'invalid-date',
        message: `${context.sheet}!${context.column}${context.row}: invalid date written as text`,
        sheet: context.sheet,
        row: context.row,
        column: context.column,
      });
      return { kind: 'empty' };
    }
    const { serial, hasTime } = dateToSerial(value);
    return { kind: 'date', serial, hasTime };
  }

  if (typeof value === 'boolean') {
    return { kind: 'boolean', value };
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      context.warnings.push({
        code: 'invalid-number',
        message: `${context.sheet}!${context.column}${context.row}: ${String(value)} written as an empty cell`,
        sheet: context.sheet,
        row: context.row,
        column: context.column,
      });
      return { kind: 'empty' };
    }
    return { kind: 'number', value };
  }

  const text = truncateCell(String(value), context);

  // A text value must never become a formula: `t="s"` (shared string) is not
  // parsed as a formula by Excel, but an inline `t="str"`/default cell holding
  // "=SUM(A1)" would be. Keeping text in the shared-string table is therefore
  // load-bearing, not an optimisation.
  if (type === 'number') {
    const trimmed = text.trim().replace(/,/g, '');
    if (trimmed !== '' && /^-?\d+(\.\d+)?$/.test(trimmed)) {
      return { kind: 'number', value: Number(trimmed) };
    }
    if (trimmed === '') {
      return { kind: 'empty' };
    }
  }

  if (type === 'date' || type === 'datetime') {
    const parsed = parseIsoDateText(text);
    if (parsed) {
      // The value decides whether it carries a time, not the column: forcing
      // `hasTime` for a datetime column would render a date-only entry as
      // "00:00", which reads as a measured time when no time was recorded.
      return { kind: 'date', ...dateToSerial(parsed) };
    }
    if (text.trim() !== '') {
      context.warnings.push({
        code: 'invalid-date',
        message: `${context.sheet}!${context.column}${context.row}: "${text}" is not an ISO-8601 date; kept as text`,
        sheet: context.sheet,
        row: context.row,
        column: context.column,
      });
    }
  }

  if (type === 'boolean') {
    const lowered = text.trim().toLowerCase();
    if (['true', 'yes', 'y', '1', 'ya'].includes(lowered)) {
      return { kind: 'boolean', value: true };
    }
    if (['false', 'no', 'n', '0', 'tidak'].includes(lowered)) {
      return { kind: 'boolean', value: false };
    }
  }

  return text === '' ? { kind: 'empty' } : { kind: 'text', text };
}

/**
 * Parses `YYYY-MM-DD`, `YYYY-MM-DDThh:mm[:ss][Z|±hh:mm]` and `YYYY/MM/DD`.
 * Date-only forms are anchored to UTC midnight so they cannot slide a day.
 */
export function parseIsoDateText(text: string): Date | null {
  const trimmed = text.trim();
  if (trimmed === '') {
    return null;
  }
  const dateOnly = /^(\d{4})[-/](\d{2})[-/](\d{2})$/.exec(trimmed);
  if (dateOnly) {
    const value = new Date(
      Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])),
    );
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    return null;
  }
  const value = new Date(trimmed);
  return Number.isNaN(value.getTime()) ? null : value;
}

function styleFor(cell: NormalisedCell): number {
  switch (cell.kind) {
    case 'link':
      return STYLE_LINK;
    case 'date':
      return cell.hasTime ? STYLE_DATETIME : STYLE_DATE;
    default:
      return STYLE_BODY;
  }
}

function cellXml(reference: string, cell: NormalisedCell, style: number, shared: SharedStrings): string {
  const styleAttr = style === STYLE_DEFAULT ? '' : ` s="${style}"`;
  switch (cell.kind) {
    case 'empty':
      return '';
    case 'text':
      return `<c r="${reference}"${styleAttr} t="s"><v>${shared.add(cell.text)}</v></c>`;
    case 'link':
      return `<c r="${reference}"${styleAttr} t="s"><v>${shared.add(cell.text)}</v></c>`;
    case 'number':
      return `<c r="${reference}"${styleAttr}><v>${cell.value}</v></c>`;
    case 'boolean':
      return `<c r="${reference}"${styleAttr} t="b"><v>${cell.value ? 1 : 0}</v></c>`;
    case 'date':
      return `<c r="${reference}"${styleAttr}><v>${cell.serial}</v></c>`;
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Sheet-name hygiene
// ---------------------------------------------------------------------------

const ILLEGAL_SHEET_CHARS = /[\\/?*[\]:]/g;

/**
 * Excel is strict about sheet names: 31 characters, no `[]:*?/\`, must not
 * start or end with an apostrophe, and must be unique within the workbook
 * (case-insensitively). A rejected name makes Excel repair — or silently drop —
 * the sheet, so it is corrected here rather than at open time.
 */
function normaliseSheetName(raw: string, used: Set<string>, warnings: XlsxWarning[]): string {
  const original = String(raw ?? '');
  let name = stripInvalidXmlChars(original).trim();

  if (name === '') {
    name = 'Sheet';
  }

  const cleaned = name.replace(ILLEGAL_SHEET_CHARS, '-').replace(/^'+|'+$/g, '');
  if (cleaned !== name) {
    name = cleaned;
    warnings.push({
      code: 'sheet-name-fixed',
      message: `Sheet name "${original}" contains characters Excel rejects; written as "${name}"`,
    });
  }
  if (name === '') {
    name = 'Sheet';
  }
  if (name.length > XLSX_MAX_SHEET_NAME) {
    name = name.slice(0, XLSX_MAX_SHEET_NAME).trim();
    warnings.push({
      code: 'sheet-name-fixed',
      message: `Sheet name "${original}" exceeds ${XLSX_MAX_SHEET_NAME} characters; written as "${name}"`,
    });
  }

  let candidate = name;
  let suffix = 2;
  while (used.has(candidate.toLowerCase())) {
    const tail = ` (${suffix})`;
    candidate = `${name.slice(0, XLSX_MAX_SHEET_NAME - tail.length)}${tail}`;
    suffix += 1;
  }
  if (candidate !== name) {
    warnings.push({
      code: 'sheet-name-deduped',
      message: `Sheet name "${name}" already used; written as "${candidate}"`,
    });
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function buildStylesXml(): string {
  return (
    `${XML_DECL}<styleSheet xmlns="${NS_MAIN}">` +
    `<numFmts count="2">` +
    `<numFmt numFmtId="${NUMFMT_DATETIME}" formatCode="${FORMAT_DATETIME}"/>` +
    `<numFmt numFmtId="${NUMFMT_DATE}" formatCode="${FORMAT_DATE}"/>` +
    `</numFmts>` +
    `<fonts count="3">` +
    `<font><sz val="10"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>` +
    `<font><b/><sz val="10"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>` +
    `<font><u/><sz val="10"/><color rgb="FF0563C1"/><name val="Calibri"/><family val="2"/></font>` +
    `</fonts>` +
    `<fills count="3">` +
    `<fill><patternFill patternType="none"/></fill>` +
    `<fill><patternFill patternType="gray125"/></fill>` +
    `<fill><patternFill patternType="solid"><fgColor rgb="FFEDEDED"/><bgColor indexed="64"/></patternFill></fill>` +
    `</fills>` +
    `<borders count="2">` +
    `<border><left/><right/><top/><bottom/><diagonal/></border>` +
    `<border>` +
    `<left style="thin"><color rgb="FFBFBFBF"/></left>` +
    `<right style="thin"><color rgb="FFBFBFBF"/></right>` +
    `<top style="thin"><color rgb="FFBFBFBF"/></top>` +
    `<bottom style="thin"><color rgb="FFBFBFBF"/></bottom>` +
    `<diagonal/></border>` +
    `</borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="6">` +
    // 0 — untouched default, used by empty/dimension cells.
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    // 1 — header.
    `<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>` +
    // 2 — body.
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
    // 3 — datetime.
    `<xf numFmtId="${NUMFMT_DATETIME}" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
    // 4 — date.
    `<xf numFmtId="${NUMFMT_DATE}" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
    // 5 — hyperlink.
    `<xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
    `</cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
    `</styleSheet>`
  );
}

// ---------------------------------------------------------------------------
// Sheet serialisation
// ---------------------------------------------------------------------------

interface SheetResult {
  xml: string;
  /** Present only when the sheet carries external hyperlinks. */
  relsPath?: string;
  relsXml?: string;
  /** 1-based column widths, so `<cols>` can be emitted compactly. */
  columnCount: number;
  rowCount: number;
}

function buildValidation(
  column: XlsxColumn,
  columnNumber: number,
  dataRows: number,
  extraRows: number,
  sheetName: string,
  warnings: XlsxWarning[],
): string {
  const values = column.values ?? [];
  if (values.length === 0) {
    return '';
  }
  const joined = values.join(',');
  // Excel has no escaping mechanism inside an inline list: a comma or a quote in
  // a value splits or truncates the list, and >255 characters is rejected on
  // open. Falling back to no dropdown (with a warning) beats a repair prompt.
  if (joined.length > 255) {
    warnings.push({
      code: 'validation-too-long',
      message: `${sheetName}: dropdown for "${column.header}" needs ${joined.length} characters (limit 255); no dropdown written`,
      sheet: sheetName,
      column: columnLetter(columnNumber),
    });
    return '';
  }
  if (values.some((value) => /[",\r\n]/.test(String(value)))) {
    warnings.push({
      code: 'validation-unsupported-chars',
      message: `${sheetName}: dropdown for "${column.header}" contains a comma, quote or line break, which Excel's inline list cannot express; no dropdown written`,
      sheet: sheetName,
      column: columnLetter(columnNumber),
    });
    return '';
  }
  const letter = columnLetter(columnNumber);
  const first = 2;
  const last = Math.max(first, dataRows + 1 + extraRows);
  const formula = `"${escapeXml(joined)}"`;
  return (
    `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" ` +
    `errorTitle="${escapeXml('Invalid value')}" ` +
    `error="${escapeXml(`Choose one of: ${values.join(', ')}`)}" sqref="${letter}${first}:${letter}${last}">` +
    `<formula1>${formula}</formula1></dataValidation>`
  );
}

function buildSheet(
  sheet: XlsxSheet,
  sheetNumber: number,
  shared: SharedStrings,
  warnings: XlsxWarning[],
): SheetResult {
  const name = sheet.name;

  const columns = sheet.columns.slice(0, XLSX_MAX_COLUMNS);
  if (sheet.columns.length > XLSX_MAX_COLUMNS) {
    warnings.push({
      code: 'column-overflow',
      message: `${name}: ${sheet.columns.length} columns exceeds Excel's ${XLSX_MAX_COLUMNS}-column limit; the extra columns were dropped`,
      sheet: name,
    });
  }

  const maxDataRows = XLSX_MAX_ROWS - 1;
  const rows = sheet.rows.slice(0, maxDataRows);
  if (sheet.rows.length > maxDataRows) {
    warnings.push({
      code: 'row-overflow',
      message: `${name}: ${sheet.rows.length} rows exceeds Excel's ${XLSX_MAX_ROWS}-row limit; the extra rows were dropped`,
      sheet: name,
    });
  }

  const columnCount = columns.length;
  const lastColumnLetters = columnLetter(Math.max(1, columnCount));
  const lastRow = rows.length + 1;

  // --- cols -----------------------------------------------------------------
  const columnsXml = columns
    .map((column, index) => {
      const width = column.width ?? DEFAULT_WIDTH[column.type ?? 'text'];
      const position = index + 1;
      return `<col min="${position}" max="${position}" width="${width}" customWidth="1"/>`;
    })
    .join('');

  // --- header + data --------------------------------------------------------
  const headerCells = columns
    .map((column, index) => {
      const reference = `${columnLetter(index + 1)}1`;
      return cellXml(reference, { kind: 'text', text: column.header }, STYLE_HEADER, shared);
    })
    .join('');
  const headerRow = columns.length === 0 ? '' : `<row r="1" spans="1:${columnCount}">${headerCells}</row>`;

  const hyperlinks: Array<{ reference: string; href: string; relId: string }> = [];
  let relCounter = 0;

  const dataRows = rows
    .map((row, rowIndex) => {
      const rowNumber = rowIndex + 2;
      const cells = columns
        .map((column, columnIndex) => {
          const reference = `${columnLetter(columnIndex + 1)}${rowNumber}`;
          const context: CellContext = {
            sheet: name,
            row: rowNumber,
            column: columnLetter(columnIndex + 1),
            warnings,
          };
          const value = Array.isArray(row) ? row[columnIndex] : undefined;
          const cell = normaliseCell(value, column, context);
          if (cell.kind === 'link' && cell.href) {
            relCounter += 1;
            hyperlinks.push({ reference, href: cell.href, relId: `rId${relCounter}` });
          }
          return cellXml(reference, cell, styleFor(cell), shared);
        })
        .join('');
      return `<row r="${rowNumber}" spans="1:${Math.max(1, columnCount)}">${cells}</row>`;
    })
    .join('');

  if (columnCount > 0 && rows.length === 0) {
    warnings.push({
      code: 'empty-sheet',
      message: `${name}: headers only, no data rows`,
      sheet: name,
    });
  }

  // --- sheet views ---------------------------------------------------------
  const freeze = sheet.freezeHeader !== false && columnCount > 0;
  const viewsXml = freeze
    ? `<sheetViews><sheetView workbookViewId="0"${sheetNumber === 1 ? ' tabSelected="1"' : ''}>` +
      `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>` +
      `<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>` +
      `</sheetView></sheetViews>`
    : `<sheetViews><sheetView workbookViewId="0"${sheetNumber === 1 ? ' tabSelected="1"' : ''}/></sheetViews>`;

  // --- auto filter ---------------------------------------------------------
  const autoFilter = (sheet.autoFilter ?? columnCount > 1) && columnCount > 0
    ? `<autoFilter ref="A1:${lastColumnLetters}${lastRow}"/>`
    : '';

  // --- validations ---------------------------------------------------------
  const extraRows = sheet.validationExtraRows ?? DEFAULT_VALIDATION_EXTRA_ROWS;
  const validations = columns
    .map((column, index) => buildValidation(column, index + 1, rows.length, extraRows, name, warnings))
    .filter((entry) => entry !== '');
  const dataValidations = validations.length
    ? `<dataValidations count="${validations.length}">${validations.join('')}</dataValidations>`
    : '';

  // --- hyperlinks ----------------------------------------------------------
  const hyperlinksXml = hyperlinks.length
    ? `<hyperlinks>${hyperlinks
        .map((link) => `<hyperlink ref="${link.reference}" r:id="${link.relId}"/>`)
        .join('')}</hyperlinks>`
    : '';

  const xml =
    `${XML_DECL}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    `<dimension ref="A1:${lastColumnLetters}${lastRow}"/>` +
    viewsXml +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    (columnsXml ? `<cols>${columnsXml}</cols>` : '') +
    `<sheetData>${headerRow}${dataRows}</sheetData>` +
    autoFilter +
    dataValidations +
    hyperlinksXml +
    `<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>` +
    `</worksheet>`;

  const relsPath = hyperlinks.length ? `xl/worksheets/_rels/sheet${sheetNumber}.xml.rels` : undefined;
  const relsXml = hyperlinks.length
    ? `${XML_DECL}<Relationships xmlns="${NS_PKG_REL}">${hyperlinks
        .map(
          (link) =>
            `<Relationship Id="${link.relId}" Type="${REL_TYPE.hyperlink}" Target="${escapeXml(link.href)}" TargetMode="External"/>`,
        )
        .join('')}</Relationships>`
    : undefined;

  return { xml, relsPath, relsXml, columnCount, rowCount: lastRow };
}

// ---------------------------------------------------------------------------
// Workbook assembly
// ---------------------------------------------------------------------------

export type XlsxZipFn = (files: Record<string, Uint8Array>) => Uint8Array;

export interface XlsxParts {
  /** Part path → XML text, in the order they should be written to the archive. */
  files: Record<string, string>;
  warnings: XlsxWarning[];
  sheetNames: string[];
}

function coreXml(workbook: XlsxWorkbook, timestamp: Date): string {
  const iso = Number.isNaN(timestamp.getTime())
    ? '1970-01-01T00:00:00Z'
    : timestamp.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const title = escapeXml(workbook.title ?? '');
  const creator = escapeXml(workbook.creator ?? 'ADO Code');
  return (
    `${XML_DECL}<cp:coreProperties ` +
    `xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
    `xmlns:dcterms="http://purl.org/dc/terms/" ` +
    `xmlns:dcmitype="http://purl.org/dc/dcmitype/" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    (workbook.title ? `<dc:title>${title}</dc:title>` : '') +
    (workbook.subject ? `<dc:subject>${escapeXml(workbook.subject)}</dc:subject>` : '') +
    `<dc:creator>${creator}</dc:creator>` +
    `<cp:lastModifiedBy>${creator}</cp:lastModifiedBy>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified>` +
    `</cp:coreProperties>`
  );
}

function appXml(): string {
  return (
    `${XML_DECL}<Properties ` +
    `xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ` +
    `xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
    `<Application>ADO Code</Application>` +
    `</Properties>`
  );
}

/**
 * Builds every OOXML part. Split from {@link serializeXlsx} so the archive can
 * be asserted part-by-part without a ZIP implementation in the test process.
 */
export function buildWorkbookParts(workbook: XlsxWorkbook): XlsxParts {
  const warnings: XlsxWarning[] = [];
  const shared = new SharedStrings();
  const timestamp = workbook.generatedAt ?? new Date();

  const sourceSheets = workbook.sheets.length > 0 ? workbook.sheets : [];
  if (sourceSheets.length === 0) {
    warnings.push({
      code: 'empty-workbook',
      message: 'No sheets supplied; wrote a single empty sheet named "Sheet1"',
    });
  }

  const usedNames = new Set<string>();
  const prepared = (sourceSheets.length > 0 ? sourceSheets : [{ name: 'Sheet1', columns: [], rows: [] }]).map(
    (sheet) => ({ sheet, name: normaliseSheetName(sheet.name, usedNames, warnings) }),
  );

  const sheetResults = prepared.map(({ sheet, name }, index) =>
    buildSheet({ ...sheet, name }, index + 1, shared, warnings),
  );

  const files: Record<string, string> = {};

  const contentTypes =
    `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    prepared
      .map(
        (_entry, index) =>
          `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ` +
          `ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join('') +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>` +
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
    `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
    `</Types>`;

  files['[Content_Types].xml'] = contentTypes;

  files['_rels/.rels'] =
    `${XML_DECL}<Relationships xmlns="${NS_PKG_REL}">` +
    `<Relationship Id="rId1" Type="${REL_TYPE.officeDocument}" Target="xl/workbook.xml"/>` +
    `<Relationship Id="rId2" Type="${REL_TYPE.coreProperties}" Target="docProps/core.xml"/>` +
    `<Relationship Id="rId3" Type="${REL_TYPE.extendedProperties}" Target="docProps/app.xml"/>` +
    `</Relationships>`;

  files['docProps/core.xml'] = coreXml(workbook, timestamp);
  files['docProps/app.xml'] = appXml();

  const sheetEntries = prepared
    .map(
      (entry, index) =>
        `<sheet name="${escapeXml(entry.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join('');

  files['xl/workbook.xml'] =
    `${XML_DECL}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    `<workbookPr/>` +
    `<bookViews><workbookView/></bookViews>` +
    `<sheets>${sheetEntries}</sheets>` +
    `</workbook>`;

  const stylesRelId = prepared.length + 1;
  const sharedStringsRelId = prepared.length + 2;

  files['xl/_rels/workbook.xml.rels'] =
    `${XML_DECL}<Relationships xmlns="${NS_PKG_REL}">` +
    prepared
      .map(
        (_entry, index) =>
          `<Relationship Id="rId${index + 1}" Type="${REL_TYPE.worksheet}" Target="worksheets/sheet${index + 1}.xml"/>`,
      )
      .join('') +
    `<Relationship Id="rId${stylesRelId}" Type="${REL_TYPE.styles}" Target="styles.xml"/>` +
    `<Relationship Id="rId${sharedStringsRelId}" Type="${REL_TYPE.sharedStrings}" Target="sharedStrings.xml"/>` +
    `</Relationships>`;

  files['xl/styles.xml'] = buildStylesXml();

  sheetResults.forEach((result, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = result.xml;
    if (result.relsPath && result.relsXml) {
      files[result.relsPath] = result.relsXml;
    }
  });

  // Written last: `toXml()` needs the final reference count from every sheet.
  files['xl/sharedStrings.xml'] = shared.toXml();

  return { files, warnings, sheetNames: prepared.map((entry) => entry.name) };
}

/**
 * Builds the parts and hands them to a ZIP implementation.
 *
 * The ZIP function is injected (the webview passes `fflate.zipSync`) so this
 * module stays dependency-free and the archive can be built and inspected in
 * any JavaScript runtime.
 */
export function serializeXlsx(
  workbook: XlsxWorkbook,
  zip: XlsxZipFn,
): { bytes: Uint8Array; warnings: XlsxWarning[]; sheetNames: string[] } {
  const { files, warnings, sheetNames } = buildWorkbookParts(workbook);
  const entries: Record<string, Uint8Array> = {};
  for (const path of Object.keys(files)) {
    entries[path] = utf8Encode(files[path]);
  }
  return { bytes: zip(entries), warnings, sheetNames };
}

// ---------------------------------------------------------------------------
// Model helpers
// ---------------------------------------------------------------------------

export interface InfoSheetOptions {
  name?: string;
  title?: string;
  generatedAt?: Date;
  /** Label/value pairs — the provenance block a reviewer reads first. */
  fields: Array<[string, string]>;
  /** Free-text lines rendered under a "Notes" heading. */
  notes?: string[];
}

/**
 * The `Info`/`README` sheet every generated workbook starts with: what produced
 * this file, when, and from which sources. Without it a reviewer has no way to
 * tell the spreadsheet in their inbox from the Markdown in the repository.
 */
export function infoSheet(options: InfoSheetOptions): XlsxSheet {
  const rows: XlsxCellValue[][] = options.fields.map(([label, value]) => [label, value]);
  if (options.generatedAt) {
    rows.push(['Generated at (UTC)', options.generatedAt]);
  }
  if (options.title) {
    rows.unshift(['Workbook', options.title]);
  }
  if (options.notes && options.notes.length > 0) {
    rows.push([null, null]);
    rows.push(['Notes', null]);
    for (const note of options.notes) {
      rows.push([null, note]);
    }
  }
  return {
    name: options.name ?? 'Info',
    columns: [
      { header: 'Field', type: 'text', width: 26 },
      { header: 'Value', type: 'text', width: 72 },
    ],
    rows,
    autoFilter: false,
  };
}

export interface TableSheetOptions {
  name: string;
  /** Column header → dropdown vocabulary, for enumerated columns. */
  enumColumns?: Record<string, string[]>;
  /** Column header → width override. */
  widths?: Record<string, number>;
  /**
   * Force a column's type instead of inferring it. Inference is conservative
   * (all non-empty values must agree), so an override is how a register keeps
   * `TC-001` as text if it ever looks numeric.
   */
  types?: Record<string, XlsxColumnType>;
  validationExtraRows?: number;
}

/**
 * Converts a parsed Markdown table into a sheet.
 *
 * Cells keep their inline Markdown in the block model (`**REQ-001**`), so the
 * text is flattened through the SAME inline parser the DOCX renderer uses
 * rather than a regex strip — one parser, one result, no drift between the two
 * export paths.
 */
export function sheetFromTable(
  table: Extract<DocBlock, { kind: 'table' }>,
  options: TableSheetOptions,
): XlsxSheet {
  const plain = (cell: string): string => runsToText(parseInline(cell ?? '')).trim();
  const header = (table.header ?? []).map(plain);
  const dataRows = (table.rows ?? []).map((row) =>
    header.map((_column, index) => plain(Array.isArray(row) ? row[index] ?? '' : '')),
  );

  const columns: XlsxColumn[] = header.map((label, index) => {
    const forced = options.types?.[label];
    const values = options.enumColumns?.[label];
    const type = forced ?? (values && values.length > 0 ? 'enum' : inferColumnType(dataRows.map((row) => row[index])));
    return {
      header: label,
      type,
      width: options.widths?.[label],
      values,
    };
  });

  const rows: XlsxCellValue[][] = dataRows.map((row) =>
    columns.map((column, columnIndex) => {
      const text = row[columnIndex];
      if (text === '') {
        return null;
      }
      if (column.type === 'date' || column.type === 'datetime') {
        return parseIsoDateText(text) ?? text;
      }
      if (column.type === 'number') {
        const numeric = Number(text.replace(/,/g, ''));
        return Number.isFinite(numeric) ? numeric : text;
      }
      return text;
    }),
  );

  return {
    name: options.name,
    columns,
    rows,
    validationExtraRows: options.validationExtraRows,
  };
}

function inferColumnType(values: string[]): XlsxColumnType {
  const nonEmpty = values.filter((value) => value !== '');
  if (nonEmpty.length === 0) {
    return 'text';
  }
  if (nonEmpty.every((value) => parseIsoDateText(value) !== null)) {
    return nonEmpty.every((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)) ? 'date' : 'datetime';
  }
  if (nonEmpty.every((value) => /^-?\d+(\.\d+)?$/.test(value.replace(/,/g, '')))) {
    return 'number';
  }
  return 'text';
}
