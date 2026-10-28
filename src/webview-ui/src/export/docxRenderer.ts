/**
 * docxRenderer — translates the renderer-neutral document model into a real
 * `.docx` and returns it as base64.
 *
 * Everything decision-like lives in `src/shared/docxLayout.ts` (and is unit
 * tested there); this module is deliberately mechanical: one Word object per
 * planned block. It runs in the WEBVIEW, so `docx` is a lazy-loaded chunk and
 * the host never carries the dependency — the bytes go back over the existing
 * base64 save bridge.
 *
 * Content the format cannot express is never dropped silently: `planDocument`
 * turns it into a visible notice paragraph plus a warning, and both are
 * surfaced to the user.
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TabStopType,
  TextRun,
  VerticalAlign,
  WidthType,
  type IParagraphOptions,
} from 'docx';

import { parseInline, type DocFrontMatter, type DocRun, type ParsedDoc } from '../../../shared/docBlocks';
import {
  DOC_GEOMETRY,
  planDocument,
  type DocxImageCollection,
  type DocxPlan,
  type FooterSegment,
  type PlannedBlock,
} from '../../../shared/docxLayout';

export interface RenderDocxOptions {
  /** Recorded in the file's document properties (not visible in the body). */
  creator?: string;
  maxWidthPx?: number;
  /** Omit the running header for short documents. */
  includeHeader?: boolean;
}

export interface RenderDocxResult {
  /** Standard base64 (no data-URI prefix) — ready for the save bridge. */
  base64: string;
  /** Everything that will differ from the Markdown source. */
  warnings: string[];
  /** The plan the render used; lets a caller inspect cover rows, geometry, etc. */
  plan: DocxPlan;
}

const NUMBERING_REFERENCE = 'doc-ordered-list';
const BODY_FONT = 'Calibri';
const CODE_FONT = 'Consolas';
const BORDER_COLOR = 'BFBFBF';
const HEADER_FILL = 'E7E6E6';
const CODE_FILL = 'F5F5F5';

/** `atob` exists in the webview and in Node 16+; no Buffer polyfill needed. */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/* -------------------------------------------------------------------------- */
/* Inline runs                                                                 */
/* -------------------------------------------------------------------------- */

function textRun(run: DocRun): TextRun {
  return new TextRun({
    text: run.text,
    bold: run.bold,
    italics: run.italic,
    strike: run.strike,
    font: run.code ? CODE_FONT : undefined,
    size: run.code ? 18 : undefined,
  });
}

/** Inline runs, with links becoming real Word hyperlinks. */
function inlineRuns(runs: DocRun[]): Array<TextRun | ExternalHyperlink> {
  return runs.map((run) => {
    if (run.link) {
      return new ExternalHyperlink({
        link: run.link,
        children: [new TextRun({ text: run.text, style: 'Hyperlink' })],
      });
    }
    return textRun(run);
  });
}

/* -------------------------------------------------------------------------- */
/* Blocks                                                                     */
/* -------------------------------------------------------------------------- */

function headingParagraph(level: number, runs: DocRun[], text: string): Paragraph {
  const children = runs.length > 0 ? inlineRuns(runs) : [new TextRun({ text, bold: true })];
  const heading = headingFor(level);
  if (!heading) {
    // H5/H6 are rare in these templates; render them as bold body text rather
    // than inventing a style Word may not have.
    return new Paragraph({ children: [new TextRun({ text, bold: true })], spacing: { before: 240, after: 80 } });
  }
  return new Paragraph({ children, heading, spacing: { before: 240, after: 120 } });
}

function headingFor(level: number): (typeof HeadingLevel)[keyof typeof HeadingLevel] | undefined {
  switch (level) {
    case 1:
      return HeadingLevel.HEADING_1;
    case 2:
      return HeadingLevel.HEADING_2;
    case 3:
      return HeadingLevel.HEADING_3;
    case 4:
      return HeadingLevel.HEADING_4;
    default:
      return undefined;
  }
}

function listParagraphs(ordered: boolean, items: PlannedBlock & { kind: 'list' }): Paragraph[] {
  return items.items.map((item) => {
    const level = Math.max(0, Math.min(item.level, 8));
    const children: TextRun[] = [new TextRun({ text: item.checked === undefined ? '' : item.checked ? '☑ ' : '☐ ' }), ...item.runs.map(textRun)];
    const base: IParagraphOptions = {
      children,
      spacing: { after: 60 },
    };
    if (ordered) {
      return new Paragraph({ ...base, numbering: { reference: NUMBERING_REFERENCE, level } });
    }
    return new Paragraph({ ...base, bullet: { level } });
  });
}

function tableFromPlan(block: PlannedBlock & { kind: 'table' }): Table {
  const widths = block.columnWidthsTwip;
  const alignmentFor = (index: number): (typeof AlignmentType)[keyof typeof AlignmentType] => {
    switch (block.align[index]) {
      case 'center':
        return AlignmentType.CENTER;
      case 'right':
        return AlignmentType.RIGHT;
      default:
        return AlignmentType.LEFT;
    }
  };

  const headerRow = new TableRow({
    tableHeader: true,
    children: block.header.map(
      (cell, index) =>
        new TableCell({
          width: { size: widths[index] ?? widths[widths.length - 1], type: WidthType.DXA },
          shading: { type: ShadingType.CLEAR, fill: HEADER_FILL, color: 'auto' },
          margins: { top: 60, bottom: 60, left: 100, right: 100 },
          children: [
            new Paragraph({
              alignment: alignmentFor(index),
              children: parseInline(cell).map((run) => textRun({ ...run, bold: true })),
              spacing: { after: 0 },
            }),
          ],
        }),
    ),
  });

  const bodyRows = block.rows.map(
    (row) =>
      new TableRow({
        children: row.map(
          (cell, index) =>
            new TableCell({
              width: { size: widths[index] ?? widths[widths.length - 1], type: WidthType.DXA },
              margins: { top: 60, bottom: 60, left: 100, right: 100 },
              verticalAlign: VerticalAlign.TOP,
              children: [
                new Paragraph({
                  alignment: alignmentFor(index),
                  children: inlineRuns(parseInline(cell)),
                  spacing: { after: 0 },
                }),
              ],
            }),
        ),
      }),
  );

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: widths,
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: BORDER_COLOR },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER_COLOR },
      left: { style: BorderStyle.SINGLE, size: 4, color: BORDER_COLOR },
      right: { style: BorderStyle.SINGLE, size: 4, color: BORDER_COLOR },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: BORDER_COLOR },
      insideVertical: { style: BorderStyle.SINGLE, size: 4, color: BORDER_COLOR },
    },
    rows: [headerRow, ...bodyRows],
  });
}

function codeBlock(text: string): Table {
  const lines = text.split(/\r?\n/);
  const runs = lines.map(
    (line, index) =>
      new TextRun({
        text: line,
        font: CODE_FONT,
        size: 18,
        break: index === 0 ? undefined : 1,
      }),
  );
  // A shaded single-cell table is used because paragraph shading is far less
  // reliable across Word versions than a table cell fill.
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: [DOC_GEOMETRY.contentWidthTwip],
    borders: {
      top: { style: BorderStyle.SINGLE, size: 2, color: BORDER_COLOR },
      bottom: { style: BorderStyle.SINGLE, size: 2, color: BORDER_COLOR },
      left: { style: BorderStyle.SINGLE, size: 2, color: BORDER_COLOR },
      right: { style: BorderStyle.SINGLE, size: 2, color: BORDER_COLOR },
    },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: DOC_GEOMETRY.contentWidthTwip, type: WidthType.DXA },
            shading: { type: ShadingType.CLEAR, fill: CODE_FILL, color: 'auto' },
            margins: { top: 100, bottom: 100, left: 120, right: 120 },
            children: [new Paragraph({ children: runs, spacing: { after: 0 } })],
          }),
        ],
      }),
    ],
  });
}

function imageParagraph(block: PlannedBlock & { kind: 'image' }): Paragraph {
  const { image, alt } = block;
  if (!image.ok) {
    const reason =
      image.reason === 'unsupported-format'
        ? `Image replaced by placeholder — ${image.ref} cannot be embedded in Word.`
        : `Image not found — ${image.ref || '(empty reference)'}`;
    return noticeParagraph(reason);
  }
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 120, after: 120 },
    children: [
      new ImageRun({
        type: image.type,
        data: base64ToBytes(image.base64),
        transformation: { width: image.widthPx, height: image.heightPx },
        altText: { title: alt, description: alt, name: alt },
      }),
    ],
  });
}

function noticeParagraph(text: string): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text: `[!] ${text}`, italics: true, color: '808080' })],
    spacing: { before: 80, after: 80 },
    border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'CCCCCC', space: 6 } },
    indent: { left: 240 },
  });
}

function quoteParagraph(block: PlannedBlock & { kind: 'paragraph' }): Paragraph {
  return new Paragraph({
    children: inlineRuns(block.runs),
    indent: { left: 480 },
    spacing: { after: 120 },
    border: { left: { style: BorderStyle.SINGLE, size: 12, color: BORDER_COLOR, space: 6 } },
  });
}

function blockToObjects(block: PlannedBlock): Array<Paragraph | Table> {
  switch (block.kind) {
    case 'heading':
      return [headingParagraph(block.level, block.runs, block.text)];
    case 'paragraph':
      return block.quote
        ? [quoteParagraph(block)]
        : [new Paragraph({ children: inlineRuns(block.runs), spacing: { after: 120 } })];
    case 'list':
      return listParagraphs(block.ordered, block);
    case 'table':
      return [tableFromPlan(block), new Paragraph({ children: [], spacing: { after: 120 } })];
    case 'code':
      return [codeBlock(block.text), new Paragraph({ children: [], spacing: { after: 120 } })];
    case 'image':
      return [imageParagraph(block)];
    case 'pagebreak':
      return [new Paragraph({ children: [new PageBreak()] })];
    case 'rule':
      return [
        new Paragraph({
          children: [],
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC', space: 1 } },
          spacing: { before: 120, after: 120 },
        }),
      ];
    case 'notice':
      return [noticeParagraph(block.text)];
    default:
      return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Cover page, header, footer                                                  */
/* -------------------------------------------------------------------------- */

function coverPage(plan: DocxPlan, meta: DocFrontMatter): Array<Paragraph | Table> {
  const widths = [3000, DOC_GEOMETRY.contentWidthTwip - 3000];
  const objects: Array<Paragraph | Table> = [
    new Paragraph({
      children: [new TextRun({ text: plan.cover.title, bold: true, size: 48 })],
      spacing: { after: 240 },
    }),
  ];

  if (plan.cover.banner) {
    objects.push(
      new Paragraph({
        shading: { type: ShadingType.CLEAR, fill: plan.cover.banner.fill, color: 'auto' },
        children: [new TextRun({ text: plan.cover.banner.text, bold: true })],
        spacing: { after: 240 },
      }),
    );
  }

  objects.push(
    new Paragraph({
      children: [new TextRun({ text: plan.labels.coverTitle, bold: true, size: 26 })],
      spacing: { before: 120, after: 120 },
    }),
  );

  objects.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: widths,
      borders: {
        top: { style: BorderStyle.SINGLE, size: 4, color: BORDER_COLOR },
        bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER_COLOR },
        left: { style: BorderStyle.SINGLE, size: 4, color: BORDER_COLOR },
        right: { style: BorderStyle.SINGLE, size: 4, color: BORDER_COLOR },
        insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: BORDER_COLOR },
        insideVertical: { style: BorderStyle.SINGLE, size: 4, color: BORDER_COLOR },
      },
      rows: plan.cover.rows.map(
        (row) =>
          new TableRow({
            children: [
              new TableCell({
                width: { size: widths[0], type: WidthType.DXA },
                shading: { type: ShadingType.CLEAR, fill: HEADER_FILL, color: 'auto' },
                margins: { top: 60, bottom: 60, left: 100, right: 100 },
                children: [new Paragraph({ children: [new TextRun({ text: row.label, bold: true })], spacing: { after: 0 } })],
              }),
              new TableCell({
                width: { size: widths[1], type: WidthType.DXA },
                margins: { top: 60, bottom: 60, left: 100, right: 100 },
                children: [new Paragraph({ children: [new TextRun({ text: row.value })], spacing: { after: 0 } })],
              }),
            ],
          }),
      ),
    }),
  );

  if (meta.status.trim()) {
    objects.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `${plan.labels.status}: ${plan.cover.rows.find((row) => row.label === plan.labels.status)?.value ?? meta.status}`,
            color: '666666',
            size: 18,
          }),
        ],
        spacing: { before: 240 },
      }),
    );
  }

  // The body always starts on a fresh page behind the cover.
  objects.push(new Paragraph({ children: [new PageBreak()] }));
  return objects;
}

function footerParagraph(segments: FooterSegment[]): Paragraph {
  const children: Array<string | (typeof PageNumber)[keyof typeof PageNumber]> = [];
  for (const segment of segments) {
    if ('text' in segment) {
      children.push(segment.text);
    } else {
      children.push(segment.field === 'page' ? PageNumber.CURRENT : PageNumber.TOTAL_PAGES);
    }
  }
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ children, size: 18, color: '666666' })],
  });
}

function headerParagraph(plan: DocxPlan): Paragraph {
  const header = plan.header;
  const left = header?.left ?? '';
  const right = header?.right ?? '';
  return new Paragraph({
    tabStops: [{ type: TabStopType.RIGHT, position: DOC_GEOMETRY.contentWidthTwip }],
    children: [
      new TextRun({ text: left, size: 18, color: '666666' }),
      new TextRun({ text: `\t${right}`, size: 18, bold: true, color: '666666' }),
    ],
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER_COLOR, space: 2 } },
  });
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Renders a parsed Markdown document to DOCX.
 *
 * Never throws for content reasons — a document with broken images or blocks
 * Word cannot express still renders, with the omissions stated in the file and
 * returned as `warnings`. It only rejects if `docx` itself fails.
 */
export async function renderDocx(
  parsed: ParsedDoc,
  images: DocxImageCollection,
  options: RenderDocxOptions = {},
): Promise<RenderDocxResult> {
  const plan = planDocument(parsed, images, {
    maxWidthPx: options.maxWidthPx,
    includeHeader: options.includeHeader,
  });

  const body: Array<Paragraph | Table> = coverPage(plan, parsed.meta);
  for (const block of plan.blocks) {
    body.push(...blockToObjects(block));
  }
  if (body.length === 0) {
    body.push(new Paragraph({ children: [] }));
  }

  const document = new Document({
    creator: options.creator ?? 'ADO Code',
    title: plan.cover.title,
    description: `${parsed.meta.docId} v${parsed.meta.version}`.trim(),
    styles: {
      default: {
        document: {
          run: { font: BODY_FONT, size: 22 },
          paragraph: { spacing: { line: 276, after: 120 } },
        },
      },
    },
    numbering: {
      config: [
        {
          reference: NUMBERING_REFERENCE,
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: '%1.',
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            },
            {
              level: 1,
              format: LevelFormat.LOWER_LETTER,
              text: '%2.',
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 1440, hanging: 360 } } },
            },
            {
              level: 2,
              format: LevelFormat.LOWER_ROMAN,
              text: '%3.',
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 2160, hanging: 360 } } },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: DOC_GEOMETRY.pageWidthTwip, height: DOC_GEOMETRY.pageHeightTwip },
            margin: {
              top: DOC_GEOMETRY.marginTwip,
              right: DOC_GEOMETRY.marginTwip,
              bottom: DOC_GEOMETRY.marginTwip,
              left: DOC_GEOMETRY.marginTwip,
              header: DOC_GEOMETRY.headerTwip,
              footer: DOC_GEOMETRY.footerTwip,
            },
          },
        },
        headers: plan.header ? { default: new Header({ children: [headerParagraph(plan)] }) } : undefined,
        footers: { default: new Footer({ children: [footerParagraph(plan.footer)] }) },
        children: body,
      },
    ],
  });

  const base64 = await Packer.toBase64String(document);
  return { base64, warnings: plan.warnings, plan };
}
