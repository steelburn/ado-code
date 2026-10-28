/**
 * binaryExport — the dependency-free half of the `saveBinary` bridge.
 *
 * Every decision about *what* gets written (payload validation, file name,
 * extension, dialog filters, default folder) lives here so it is testable
 * headlessly; `src/webview/saveBinary.ts` only performs the dialog + write.
 *
 * Deliberately framework-free: no `vscode`, no `Buffer`, no DOM. It is
 * imported by the host, so it must stay importable from the webview build too
 * (same rule as `docBlocks` / `imageSize` / `xlsx`).
 */

/** 64 MB — comfortably above any document/diagram/evidence payload we emit. */
export const MAX_SAVE_BYTES = 64 * 1024 * 1024;

/** Keeps a filename inside the Windows/OneDrive-safe envelope. */
export const MAX_FILE_NAME_LENGTH = 120;

/** A save dialog with more than a handful of entries is unusable. */
export const MAX_FILTERS = 8;

/** What the webview posts (and what `saveBinary` carries on the wire). */
export interface BinarySaveRequest {
  /** Bare base64 (a `data:` prefix is tolerated and stripped). */
  content: string;
  /** MIME type of the decoded bytes, e.g. `image/png`. */
  mime: string;
  /** Suggested file name; the extension is corrected from `mime`. */
  defaultName?: string;
  /** Sub-folder of the first workspace folder to start the dialog in. */
  defaultDir?: string;
  /** Explicit dialog filters; derived from `mime` when omitted. */
  filters?: Record<string, string[]>;
}

export interface SavePlan {
  fileName: string;
  /** Workspace-relative folder, `''` for the workspace root. */
  defaultDir: string;
  filters: Record<string, string[]>;
  /**
   * The exact base64 that was validated (prefix stripped, whitespace removed).
   * The writer MUST decode this and not the raw request: `Buffer.from` happily
   * decodes a `data:` URI into garbage instead of failing.
   */
  payload: string;
  /** Decoded byte length (used for the confirmation message). */
  bytes: number;
  mime: string;
  extension?: string;
}

export type SavePlanFailure = 'empty' | 'not-base64' | 'too-large';

export type SavePlanResult =
  | { ok: true; plan: SavePlan }
  | { ok: false; reason: SavePlanFailure; message: string };

const MIME_EXTENSIONS: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'application/msword': 'doc',
  'application/pdf': 'pdf',
  'application/json': 'json',
  'application/zip': 'zip',
  'application/octet-stream': 'bin',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'text/csv': 'csv',
  'text/markdown': 'md',
  'text/plain': 'txt',
  'text/html': 'html',
};

const EXTENSION_LABELS: Record<string, string> = {
  docx: 'Word document',
  xlsx: 'Excel workbook',
  xls: 'Excel workbook (legacy)',
  doc: 'Word document (legacy)',
  pdf: 'PDF document',
  json: 'JSON file',
  zip: 'Zip archive',
  bin: 'Binary file',
  png: 'PNG image',
  jpg: 'JPEG image',
  gif: 'GIF image',
  webp: 'WebP image',
  svg: 'SVG image',
  bmp: 'Bitmap image',
  csv: 'CSV file',
  md: 'Markdown file',
  txt: 'Text file',
  html: 'HTML file',
};

/**
 * Extensions we are willing to *replace* when correcting a suggestion.
 * Anything else is treated as part of the name (`report.final` -> `report.final.docx`),
 * so a dotted project name never loses a segment.
 */
const REPLACEABLE_EXTENSIONS = new Set(Object.values(MIME_EXTENSIONS));

const RESERVED_FILE_NAMES = new Set([
  'con', 'prn', 'aux', 'nul', 'conin$', 'conout$',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** Windows forbids these outright; the rest are stripped as control chars. */
// eslint-disable-next-line no-control-regex
const ILLEGAL_FILE_NAME_CHARS = /[<>:"|?*\u0000-\u001f]/g;

const BASE64_CLEAN = /^[A-Za-z0-9+/]*={0,2}$/;

/** `image/PNG; charset=binary` -> `image/png`. */
export function normaliseMime(mime: string): string {
  if (!mime) {
    return '';
  }
  const bare = mime.split(';')[0].trim().toLowerCase();
  return bare;
}

export function extensionForMime(mime: string): string | undefined {
  return MIME_EXTENSIONS[normaliseMime(mime)];
}

/** Human label used for a derived dialog filter (`docx` -> `Word document`). */
export function filterLabel(extension: string): string {
  const normalised = extension.toLowerCase();
  return EXTENSION_LABELS[normalised] ?? `${normalised.toUpperCase()} file`;
}

/**
 * Tolerates (and strips) a `data:<mime>;base64,` prefix. Everything we emit is
 * bare base64, but a caller that forwards a `FileReader` result verbatim would
 * otherwise write the literal prefix into the file — a silent corruption that
 * only shows up when Word/Excel refuses the result.
 */
export function stripBase64Prefix(content: string): string {
  const trimmed = (content ?? '').trim();
  if (!/^data:[^,]*;base64,/i.test(trimmed)) {
    return trimmed;
  }
  return trimmed.slice(trimmed.indexOf(',') + 1);
}

/** The canonical base64 form: data-URI prefix stripped, whitespace removed. */
export function cleanBase64(content: string): string {
  return stripBase64Prefix(content).replace(/\s+/g, '');
}

export interface Base64Validation {
  ok: boolean;
  bytes: number;
  reason?: SavePlanFailure;
  message?: string;
}

/**
 * Validates a base64 payload and reports its decoded size without decoding.
 * Unpadded input is accepted (`Packer.toBase64String` pads, but not every
 * producer does); a length remainder of 1 is impossible in base64 and rejected.
 */
export function validateBase64Payload(
  content: string,
  maxBytes: number = MAX_SAVE_BYTES,
): Base64Validation {
  const clean = cleanBase64(content);
  if (!clean) {
    return {
      ok: false,
      bytes: 0,
      reason: 'empty',
      message: 'Nothing to save — the export produced no content.',
    };
  }
  if (!BASE64_CLEAN.test(clean)) {
    return {
      ok: false,
      bytes: 0,
      reason: 'not-base64',
      message: 'Export payload is not valid base64 — nothing was written.',
    };
  }
  const remainder = clean.length % 4;
  if (remainder === 1) {
    return {
      ok: false,
      bytes: 0,
      reason: 'not-base64',
      message: 'Export payload is not valid base64 (truncated) — nothing was written.',
    };
  }
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const bytes = Math.floor((clean.length * 3) / 4) - padding;
  if (bytes > maxBytes) {
    return {
      ok: false,
      bytes,
      reason: 'too-large',
      message:
        `Export is ${describeBytes(bytes)}, above the ${describeBytes(maxBytes)} save limit — ` +
        'nothing was written.',
    };
  }
  return { ok: true, bytes };
}

/**
 * Reduces an arbitrary string to a single safe file name segment: no path
 * separators, no characters Windows rejects, no trailing dot/space, not a
 * reserved device name, and bounded in length.
 */
export function sanitiseFileName(name: string | undefined): string {
  const raw = (name ?? '').trim();
  const base = raw.split(/[\\/]/).pop() ?? '';
  let cleaned = base.replace(ILLEGAL_FILE_NAME_CHARS, '').trim();
  cleaned = cleaned.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!cleaned) {
    return 'export';
  }
  const dot = cleaned.lastIndexOf('.');
  const stem = dot > 0 ? cleaned.slice(0, dot) : cleaned;
  if (RESERVED_FILE_NAMES.has(stem.toLowerCase())) {
    cleaned = `_${cleaned}`;
  }
  if (cleaned.length > MAX_FILE_NAME_LENGTH) {
    const ext = dot > 0 ? cleaned.slice(dot) : '';
    const keep = Math.max(1, MAX_FILE_NAME_LENGTH - ext.length);
    cleaned = `${cleaned.slice(0, keep)}${ext}`;
  }
  return cleaned;
}

/** Appends or (for a known export extension) replaces the extension. */
export function ensureExtension(fileName: string, extension?: string): string {
  if (!extension) {
    return fileName;
  }
  const wanted = extension.toLowerCase().replace(/^\./, '');
  const dot = fileName.lastIndexOf('.');
  if (dot > 0) {
    const current = fileName.slice(dot + 1).toLowerCase();
    if (current === wanted) {
      return fileName;
    }
    if (REPLACEABLE_EXTENSIONS.has(current)) {
      return `${fileName.slice(0, dot)}.${wanted}`;
    }
  }
  return `${fileName}.${wanted}`;
}

/**
 * Normalises a workspace-relative folder. Returns `''` (the workspace root) for
 * anything absolute or containing a `..` segment, so a bad `defaultDir` can
 * never start the dialog outside the project.
 */
export function normaliseDefaultDir(dir: string | undefined): string {
  const raw = (dir ?? '').trim();
  if (!raw) {
    return '';
  }
  const unified = raw.replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(unified) || unified.startsWith('/')) {
    return '';
  }
  const segments = unified.split('/').filter((s) => s && s !== '.');
  if (segments.some((s) => s === '..')) {
    return '';
  }
  return segments.join('/');
}

/**
 * Dialog filters: explicit ones win (sanitised), otherwise derived from the
 * MIME type so the dialog shows "Word document (*.docx)" rather than "All files".
 */
export function buildSaveFilters(request: BinarySaveRequest): Record<string, string[]> {
  const filters: Record<string, string[]> = {};
  let count = 0;
  for (const [rawLabel, rawExtensions] of Object.entries(request.filters ?? {})) {
    if (count >= MAX_FILTERS) {
      break;
    }
    const label = (rawLabel ?? '').trim();
    if (!label) {
      continue;
    }
    const extensions = normaliseExtensions(rawExtensions);
    if (extensions.length === 0) {
      continue;
    }
    filters[label] = extensions;
    count += 1;
  }
  if (count > 0) {
    return filters;
  }

  const derived: Record<string, string[]> = {};
  const extension = extensionForMime(request.mime)
    ?? guessExtensionFromName(request.defaultName);
  if (extension) {
    derived[filterLabel(extension)] = [extension];
  }
  derived['All files'] = ['*'];
  return derived;
}

function normaliseExtensions(raw: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw ?? []) {
    const cleaned = String(entry ?? '').trim().toLowerCase().replace(/^\./, '');
    if (!cleaned) {
      continue;
    }
    const safe = cleaned === '*' || /^[a-z0-9]+$/.test(cleaned);
    if (!safe || seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

function guessExtensionFromName(name: string | undefined): string | undefined {
  const base = (name ?? '').trim().split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) {
    return undefined;
  }
  const extension = base.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]+$/.test(extension) ? extension : undefined;
}

export function describeBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '0 B';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Validates the payload and resolves everything the save dialog needs.
 * Failures are returned, never thrown: the caller shows the message and the
 * export action simply ends.
 */
export function planBinarySave(
  request: BinarySaveRequest,
  maxBytes: number = MAX_SAVE_BYTES,
): SavePlanResult {
  const validation = validateBase64Payload(request.content, maxBytes);
  if (!validation.ok) {
    return {
      ok: false,
      reason: validation.reason ?? 'empty',
      message: validation.message ?? 'Export payload was rejected — nothing was written.',
    };
  }
  const mime = normaliseMime(request.mime);
  const extension = extensionForMime(mime) ?? guessExtensionFromName(request.defaultName);
  const fileName = ensureExtension(sanitiseFileName(request.defaultName), extension);
  return {
    ok: true,
    plan: {
      fileName,
      defaultDir: normaliseDefaultDir(request.defaultDir),
      filters: buildSaveFilters(request),
      payload: cleanBase64(request.content),
      bytes: validation.bytes,
      mime,
      extension,
    },
  };
}
