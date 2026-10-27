/**
 * docBlocks — a renderer-neutral block model for documentation Markdown.
 *
 * Two consumers share this parser:
 *   - the DOCX exporter in the webview (WordprocessingML emitted by `docx`)
 *   - host-side tooling that needs document structure without a DOM
 *
 * Documents authored for these templates therefore have to stay inside a
 * pandoc- AND docx-safe subset:
 *   - YAML front matter with `key: value` scalars (no nesting)
 *   - ATX headings (`## Heading`), never setext underlines
 *   - pipe tables with a `|---|` delimiter row
 *   - fenced code blocks; a ```mermaid fence is deliberately NOT renderable
 *   - `-` / `1.` lists (nesting by indentation, `[ ]` task markers)
 *   - `**bold**`, `*italic*`, `***both***`, `~~strike~~`, `` `code` ``, `[text](url)`
 *   - images as a whole-line `![alt](assets/img/FIG-001.png)` reference
 *   - one page-break marker: `<div class="pagebreak"></div>`
 *
 * Anything outside the subset is returned as an `unsupported` block (with a line
 * number) so an export can WARN instead of silently dropping content — for a
 * document-controlled deliverable, a silent omission is worse than an error.
 */

export type DocLang = 'en' | 'ms' | 'bilingual';

/** Parsed document header. Every value is a string — it feeds a cover page verbatim. */
export interface DocFrontMatter {
  docId: string;
  title: string;
  version: string;
  status: string;
  owner: string;
  approver: string;
  adoWorkItem: string;
  classification: string;
  lang: DocLang;
  /** Unrecognised keys, preserved so a template can carry project-specific metadata. */
  extra: Record<string, string>;
}

export interface DocRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  /** Link target when the run came from `[text](url)`; link text stays in `text`. */
  link?: string;
}

export interface DocListItem {
  /** 0-based nesting level derived from indentation. */
  level: number;
  runs: DocRun[];
  /** Present only for `- [ ]` / `- [x]` task markers. */
  checked?: boolean;
}

export type DocTableAlign = 'left' | 'center' | 'right';

export type UnsupportedReason = 'mermaid' | 'html' | 'footnote' | 'setext' | 'other';

export type DocBlock =
  | { kind: 'heading'; level: number; text: string; runs: DocRun[] }
  | { kind: 'paragraph'; runs: DocRun[]; quote?: boolean }
  | { kind: 'list'; ordered: boolean; items: DocListItem[] }
  | { kind: 'table'; header: string[]; rows: string[][]; align: Array<DocTableAlign | null> }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'image'; ref: string; alt: string; widthPx?: number }
  | { kind: 'pagebreak' }
  | { kind: 'rule' }
  | { kind: 'unsupported'; reason: UnsupportedReason; raw: string; line: number };

export type DocWarningCode =
  | 'no-front-matter'
  | 'missing-front-matter-key'
  | 'unclosed-fence'
  | 'unsupported-mermaid'
  | 'unsupported-html'
  | 'inline-html'
  | 'unsupported-footnote'
  | 'unsupported-setext'
  | 'inline-image'
  | 'inline-footnote'
  | 'table-column-mismatch';

export interface DocBlockWarning {
  /** 1-based line number in the ORIGINAL file (front matter included). */
  line: number;
  code: DocWarningCode;
  message: string;
}

export interface ParsedDoc {
  meta: DocFrontMatter;
  blocks: DocBlock[];
  warnings: DocBlockWarning[];
}

/** Front-matter keys a document MUST carry to be auditable. */
export const REQUIRED_FRONT_MATTER = ['docId', 'title', 'version', 'owner'] as const;

export const DEFAULT_FRONT_MATTER: DocFrontMatter = {
  docId: '',
  title: '',
  version: '',
  status: 'Draft',
  owner: '',
  approver: '',
  adoWorkItem: '',
  classification: 'INTERNAL',
  lang: 'en',
  extra: {},
};

/** English and Bahasa Malaysia keys map onto the same field — templates write one or the other. */
const FRONT_MATTER_ALIASES: Record<string, keyof Omit<DocFrontMatter, 'extra'>> = {
  'docid': 'docId',
  'doc-id': 'docId',
  'document-id': 'docId',
  'id-dokumen': 'docId',
  'title': 'title',
  'tajuk': 'title',
  'version': 'version',
  'versi': 'version',
  'status': 'status',
  'owner': 'owner',
  'document-owner': 'owner',
  'pemilik-dokumen': 'owner',
  'pemilik': 'owner',
  'approver': 'approver',
  'approved-by': 'approver',
  'pelulus': 'approver',
  'kelulusan': 'approver',
  'ado-work-item': 'adoWorkItem',
  'work-item': 'adoWorkItem',
  'ado': 'adoWorkItem',
  'classification': 'classification',
  'klasifikasi': 'classification',
  'lang': 'lang',
  'language': 'lang',
  'bahasa': 'lang',
};

const PAGE_BREAK_PATTERNS: RegExp[] = [
  /^\s*<div\s+class=["']pagebreak["']\s*>\s*<\/div>\s*$/i,
  /^\s*<!--\s*pagebreak\s*-->\s*$/i,
  /^\s*\\pagebreak\s*$/i,
  /^\s*\\newpage\s*$/i,
  /^\s*---\s*pagebreak\s*---\s*$/i,
];

const ITEM_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const TABLE_CELL_PROTECT = '\u0001';

/** Parse a documentation Markdown file into front matter + blocks + warnings. */
export function mdToDocBlocks(markdown: string): ParsedDoc {
  const warnings: DocBlockWarning[] = [];
  const lines = markdown.replace(/^\uFEFF/, '').split(/\r?\n/);
  const front = splitFrontMatter(lines);
  const meta = parseFrontMatter(front.raw, warnings);
  const blocks: DocBlock[] = [];

  let i = front.start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const lineNo = i + 1;

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const markerChar = fence[2][0];
      const markerLen = fence[2].length;
      const info = fence[3].trim();
      const lang = info.split(/\s+/)[0].toLowerCase();
      const body: string[] = [];
      const closeRe = new RegExp('^\\s*' + markerChar + '{' + markerLen + ',}\\s*$');
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        if (closeRe.test(lines[j])) {
          closed = true;
          break;
        }
        body.push(lines[j]);
        j++;
      }
      if (!closed) {
        warnings.push({
          line: lineNo,
          code: 'unclosed-fence',
          message: 'code fence is never closed — treated as running to the end of the file',
        });
      }
      i = closed ? j + 1 : j;
      if (lang === 'mermaid') {
        warnings.push({
          line: lineNo,
          code: 'unsupported-mermaid',
          message: 'mermaid fence cannot be rendered in DOCX — export the diagram to diagrams/DIA-###.png and embed the image',
        });
        blocks.push({ kind: 'unsupported', reason: 'mermaid', raw: body.join('\n'), line: lineNo });
      } else {
        blocks.push({ kind: 'code', lang, text: body.join('\n') });
      }
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const text = heading[2].replace(/\s+#+\s*$/, '').trim();
      const runs = parseInline(text);
      blocks.push({ kind: 'heading', level: heading[1].length, text: runsToText(runs), runs });
      i++;
      continue;
    }

    if (isPageBreak(line)) {
      blocks.push({ kind: 'pagebreak' });
      i++;
      continue;
    }

    if (/^\s*={3,}\s*$/.test(line)) {
      warnings.push({
        line: lineNo,
        code: 'unsupported-setext',
        message: 'setext heading underline is not in the docx-safe subset — use `## Heading`',
      });
      blocks.push({ kind: 'unsupported', reason: 'setext', raw: line, line: lineNo });
      i++;
      continue;
    }

    if (isRule(line)) {
      blocks.push({ kind: 'rule' });
      i++;
      continue;
    }

    if (line.includes('|') && isTableDelimiterRow(lines[i + 1] ?? '')) {
      const header = parseTableRow(line);
      const align = parseDelimiterRow(lines[i + 1] ?? '');
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].includes('|') && lines[j].trim()) {
        const cells = parseTableRow(lines[j]);
        if (cells.length !== header.length) {
          warnings.push({
            line: j + 1,
            code: 'table-column-mismatch',
            message: `row has ${cells.length} cells but the header has ${header.length} — padded/truncated to match`,
          });
        }
        rows.push(normalizeCells(cells, header.length));
        j++;
      }
      blocks.push({
        kind: 'table',
        header,
        rows,
        align: align.length === header.length ? align : header.map(() => null),
      });
      i = j;
      continue;
    }

    const item = ITEM_RE.exec(line);
    if (item) {
      const ordered = /\d/.test(item[2]);
      const items: DocListItem[] = [];
      let j = i;
      while (j < lines.length) {
        const current = lines[j];
        const m = ITEM_RE.exec(current);
        if (m) {
          if (/\d/.test(m[2]) !== ordered) {
            // marker style changed — a numbered list after a bullet list is a new block
            break;
          }
          const indent = m[1].replace(/\t/g, '  ').length;
          let text = m[3];
          let checked: boolean | undefined;
          const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
          if (task) {
            checked = task[1].toLowerCase() === 'x';
            text = task[2];
          }
          const entry: DocListItem = { level: Math.min(3, Math.floor(indent / 2)), runs: parseInline(text) };
          if (checked !== undefined) {
            entry.checked = checked;
          }
          items.push(entry);
          j++;
          continue;
        }
        if (!current.trim()) {
          let k = j + 1;
          while (k < lines.length && !lines[k].trim()) k++;
          if (k < lines.length && ITEM_RE.test(lines[k])) {
            j = k;
            continue;
          }
          break;
        }
        // Indented continuation of the previous item.
        if (/^\s{2,}/.test(current) && items.length > 0) {
          const last = items[items.length - 1];
          last.runs = mergeRuns([...last.runs, { text: ' ' }, ...parseInline(current.trim())]);
          j++;
          continue;
        }
        break;
      }
      blocks.push({ kind: 'list', ordered, items });
      i = j;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      let j = i;
      while (j < lines.length && /^\s*>/.test(lines[j])) {
        quoted.push(lines[j].replace(/^\s*>\s?/, '').trimEnd());
        j++;
      }
      blocks.push({ kind: 'paragraph', runs: parseInline(quoted.join(' ').trim()), quote: true });
      i = j;
      continue;
    }

    if (/^\s*\[\^[^\]]+\]:/.test(line)) {
      warnings.push({
        line: lineNo,
        code: 'unsupported-footnote',
        message: 'footnotes cannot be rendered in DOCX — fold the note into the paragraph',
      });
      blocks.push({ kind: 'unsupported', reason: 'footnote', raw: line, line: lineNo });
      i++;
      continue;
    }

    if (/^\s*<[a-zA-Z][\w-]*/.test(line)) {
      warnings.push({
        line: lineNo,
        code: 'unsupported-html',
        message: 'raw HTML cannot be rendered in DOCX — rewrite it as Markdown',
      });
      blocks.push({ kind: 'unsupported', reason: 'html', raw: line, line: lineNo });
      i++;
      continue;
    }

    // HTML comments are markup, not content — pandoc and every Markdown
    // renderer drop them, so the DOCX export drops them too. A multi-line
    // comment is consumed whole instead of leaking its body into a paragraph.
    if (/^\s*<!--/.test(line)) {
      let commentEnd = i;
      while (commentEnd < lines.length && !lines[commentEnd].includes('-->')) {
        commentEnd++;
      }
      i = Math.min(commentEnd + 1, lines.length);
      continue;
    }

    const image = IMAGE_LINE_RE.exec(line);
    if (image) {
      blocks.push({
        kind: 'image',
        ref: image[2],
        alt: image[1],
        ...(image[3] ? { widthPx: Number(image[3]) } : {}),
      });
      i++;
      continue;
    }

    // Paragraph: fold soft-wrapped lines, keep hard breaks (two trailing spaces or a trailing backslash).
    const paraLines: string[] = [];
    let j = i;
    while (j < lines.length && lines[j].trim() && (j === i || !startsBlock(lines, j))) {
      paraLines.push(lines[j]);
      j++;
    }
    let text = '';
    let pendingBreak = false;
    for (const raw of paraLines) {
      const hard = /(\s{2,}|\\)\s*$/.test(raw);
      let piece = raw.trim();
      if (piece.endsWith('\\')) {
        piece = piece.slice(0, -1).trimEnd();
      }
      if (text) {
        text += pendingBreak ? '\n' : ' ';
      }
      text += piece;
      pendingBreak = hard;
    }
    if (/!\[[^\]]*\]\(/.test(text)) {
      warnings.push({
        line: lineNo,
        code: 'inline-image',
        message: 'image inside a paragraph — move it to its own line so it can be embedded',
      });
    }
    if (/\[\^[^\]]+\]/.test(text)) {
      warnings.push({
        line: lineNo,
        code: 'inline-footnote',
        message: 'footnote reference cannot be rendered in DOCX — inline the text',
      });
    }
    if (/<[a-zA-Z][^>]*>/.test(text)) {
      warnings.push({
        line: lineNo,
        code: 'inline-html',
        message: 'inline HTML cannot be rendered in DOCX — use Markdown formatting instead',
      });
    }
    blocks.push({ kind: 'paragraph', runs: parseInline(text) });
    i = j;
  }

  return { meta, blocks, warnings };
}

/** Split `**bold**`, `*italic*`, `` `code` ``, `~~strike~~`, `[text](url)` and escapes into runs. */
export function parseInline(text: string): DocRun[] {
  return mergeRuns(scanInline(text, {}));
}

/** Concatenate run text, dropping formatting — for table cells, TOC entries and captions. */
export function runsToText(runs: DocRun[]): string {
  return runs.map(r => r.text).join('');
}

/** Merge adjacent runs that carry identical formatting. */
export function mergeRuns(runs: DocRun[]): DocRun[] {
  const out: DocRun[] = [];
  for (const run of runs) {
    if (!run.text) {
      continue;
    }
    const prev = out[out.length - 1];
    if (prev && sameFlags(prev, run)) {
      prev.text += run.text;
      continue;
    }
    out.push({ ...run });
  }
  return out;
}

const IMAGE_LINE_RE = /^\s*!\[([^\]]*)\]\(\s*([^)\s]+)\s*(?:"[^"]*")?\s*\)\s*(?:\{\s*width\s*=\s*(\d+)\s*(?:px)?\s*\})?\s*$/;

type FlagSet = Pick<DocRun, 'bold' | 'italic' | 'strike' | 'link'>;

function scanInline(src: string, flags: FlagSet): DocRun[] {
  const out: DocRun[] = [];
  let buf = '';
  let i = 0;
  const flush = (): void => {
    if (buf) {
      out.push({ text: buf, ...flags });
      buf = '';
    }
  };

  while (i < src.length) {
    const c = src[i];

    if (c === '\\' && i + 1 < src.length) {
      buf += src[i + 1];
      i += 2;
      continue;
    }

    if (c === '`') {
      const ticks = /^`+/.exec(src.slice(i));
      if (ticks) {
        const end = src.indexOf(ticks[0], i + ticks[0].length);
        if (end > 0) {
          flush();
          out.push({ text: src.slice(i + ticks[0].length, end).replace(/\n/g, ' '), code: true, ...flags });
          i = end + ticks[0].length;
          continue;
        }
      }
    }

    const triple = src.startsWith('***', i) ? '***' : src.startsWith('___', i) ? '___' : '';
    if (triple) {
      const end = src.indexOf(triple, i + 3);
      if (end > i + 3) {
        flush();
        out.push(...scanInline(src.slice(i + 3, end), { ...flags, bold: true, italic: true }));
        i = end + 3;
        continue;
      }
    }

    const double = src.startsWith('**', i) ? '**' : src.startsWith('__', i) ? '__' : '';
    if (double) {
      const end = src.indexOf(double, i + 2);
      if (end > i + 2) {
        flush();
        out.push(...scanInline(src.slice(i + 2, end), { ...flags, bold: true }));
        i = end + 2;
        continue;
      }
    }

    if (src.startsWith('~~', i)) {
      const end = src.indexOf('~~', i + 2);
      if (end > i + 2) {
        flush();
        out.push(...scanInline(src.slice(i + 2, end), { ...flags, strike: true }));
        i = end + 2;
        continue;
      }
    }

    if (c === '*' || c === '_') {
      const end = src.indexOf(c, i + 1);
      if (end > i + 1) {
        flush();
        out.push(...scanInline(src.slice(i + 1, end), { ...flags, italic: true }));
        i = end + 1;
        continue;
      }
    }

    if (c === '[') {
      const link = /^\[([^\]]*)\]\(\s*([^)\s]+)\s*(?:"[^"]*")?\s*\)/.exec(src.slice(i));
      if (link) {
        flush();
        out.push(...scanInline(link[1], { ...flags, link: link[2] }));
        i += link[0].length;
        continue;
      }
    }

    buf += c;
    i++;
  }

  flush();
  return out;
}

function sameFlags(a: DocRun, b: DocRun): boolean {
  return (
    !!a.bold === !!b.bold &&
    !!a.italic === !!b.italic &&
    !!a.code === !!b.code &&
    !!a.strike === !!b.strike &&
    (a.link ?? '') === (b.link ?? '')
  );
}

function splitFrontMatter(lines: string[]): { raw: string[]; start: number } {
  const firstIdx = lines.findIndex(l => l.trim().length > 0);
  if (firstIdx === -1 || lines[firstIdx].trim() !== '---') {
    return { raw: [], start: 0 };
  }
  for (let i = firstIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      return { raw: lines.slice(firstIdx + 1, i), start: i + 1 };
    }
  }
  return { raw: [], start: 0 };
}

function parseFrontMatter(raw: string[], warnings: DocBlockWarning[]): DocFrontMatter {
  const meta: DocFrontMatter = { ...DEFAULT_FRONT_MATTER, extra: {} };
  if (raw.length === 0) {
    warnings.push({
      line: 1,
      code: 'no-front-matter',
      message: 'no YAML front matter — document ID, version and classification cannot be derived',
    });
    return meta;
  }

  for (const line of raw) {
    if (!line.trim() || /^\s*#/.test(line)) {
      continue;
    }
    const m = /^([A-Za-z0-9 _.-]+):\s*(.*)$/.exec(line);
    if (!m) {
      continue;
    }
    const key = normalizeKey(m[1]);
    const value = parseScalar(m[2]);
    const target = FRONT_MATTER_ALIASES[key];
    if (!target) {
      meta.extra[key] = value;
      continue;
    }
    if (target === 'lang') {
      meta.lang = normalizeLang(value);
    } else {
      meta[target] = value;
    }
  }

  for (const key of REQUIRED_FRONT_MATTER) {
    if (!meta[key]) {
      warnings.push({
        line: 1,
        code: 'missing-front-matter-key',
        message: `front matter is missing required key '${key}'`,
      });
    }
  }
  return meta;
}

function normalizeKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/[_\s]+/g, '-');
}

function parseScalar(raw: string): string {
  let value = raw.trim();
  if (!value) {
    return '';
  }
  const quoted =
    value.length > 1 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
  if (quoted) {
    return value.slice(1, -1);
  }
  const comment = value.indexOf(' #');
  if (comment > 0) {
    value = value.slice(0, comment);
  }
  return value.trim();
}

function normalizeLang(raw: string): DocLang {
  const v = raw.trim().toLowerCase();
  if (!v) {
    return 'en';
  }
  if (/(\+|and\b|\bdual\b|bilingual|dwibahasa)/.test(v)) {
    return 'bilingual';
  }
  if (/^(ms|bm|my|malay|bahasa|bahasa-melayu|bahasa-malaysia|bahasa melayu|bahasa malaysia)$/.test(v)) {
    return 'ms';
  }
  return 'en';
}

function isPageBreak(line: string): boolean {
  return PAGE_BREAK_PATTERNS.some(re => re.test(line));
}

function isRule(line: string): boolean {
  return /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line);
}

function isTableDelimiterRow(line: string): boolean {
  if (!line || !line.includes('-')) {
    return false;
  }
  const cells = parseTableRow(line);
  return cells.length > 0 && cells.every(c => /^:?-{2,}:?$/.test(c));
}

function parseTableRow(line: string): string[] {
  const guarded = line.replace(/\\\|/g, TABLE_CELL_PROTECT);
  let body = guarded.trim();
  if (body.startsWith('|')) {
    body = body.slice(1);
  }
  if (body.endsWith('|')) {
    body = body.slice(0, -1);
  }
  return body.split('|').map(cell => cell.split(TABLE_CELL_PROTECT).join('|').trim());
}

function parseDelimiterRow(line: string): Array<DocTableAlign | null> {
  return parseTableRow(line).map(cell => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) {
      return 'center';
    }
    if (right) {
      return 'right';
    }
    if (left) {
      return 'left';
    }
    return null;
  });
}

function normalizeCells(cells: string[], width: number): string[] {
  if (cells.length === width) {
    return cells;
  }
  if (cells.length < width) {
    return [...cells, ...new Array<string>(width - cells.length).fill('')];
  }
  return cells.slice(0, width);
}

/** Does the line at `idx` open a block that must not be folded into a paragraph? */
function startsBlock(lines: string[], idx: number): boolean {
  const line = lines[idx];
  if (HEADING_RE.test(line) || FENCE_RE.test(line)) {
    return true;
  }
  if (isPageBreak(line) || isRule(line) || /^\s*={3,}\s*$/.test(line)) {
    return true;
  }
  if (ITEM_RE.test(line) || /^\s*>/.test(line)) {
    return true;
  }
  if (line.includes('|') && isTableDelimiterRow(lines[idx + 1] ?? '')) {
    return true;
  }
  if (/^\s*\[\^[^\]]+\]:/.test(line) || /^\s*<[a-zA-Z][\w-]*/.test(line)) {
    return true;
  }
  return IMAGE_LINE_RE.test(line);
}
