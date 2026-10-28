/**
 * docxLayout — every layout DECISION for the DOCX export, expressed without
 * importing the `docx` package.
 *
 * The renderer in the webview (`src/webview-ui/src/export/docxRenderer.ts`)
 * owns the mechanical translation from these plans to WordprocessingML
 * objects. Everything that can actually be *wrong* — page geometry, cover-page
 * wording, English/Bahasa Malaysia labels, the classification banner, footer
 * pagination, table column widths, and which images Word will refuse to render
 * — is decided here so it can be unit-tested headlessly.
 *
 * Two invariants matter for a document-controlled deliverable:
 *   1. Nothing is dropped silently. An image that cannot be embedded, or a
 *      block Word cannot represent, becomes a visible notice in the document
 *      AND a warning for the caller.
 *   2. A missing front-matter field renders as an explicit `(not set)` rather
 *      than a blank cell, so an incomplete cover page is obvious on review.
 */

import type {
  DocBlock,
  DocFrontMatter,
  DocLang,
  DocListItem,
  DocRun,
  DocTableAlign,
  ParsedDoc,
} from './docBlocks';
import { A4_CONTENT_WIDTH_PX } from './imageSize';

/* -------------------------------------------------------------------------- */
/* Geometry                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A4 at 20 mm margins. Word measures pages and margins in twentieths of a
 * point (twips): 1 mm = 1440 / 25.4 = 56.6929 twips.
 */
export const DOC_GEOMETRY = {
  /** 210 mm */
  pageWidthTwip: 11906,
  /** 297 mm */
  pageHeightTwip: 16838,
  /** 20 mm — used for all four edges. */
  marginTwip: 1134,
  /** Distance from the page edge to the running header / footer. */
  headerTwip: 567,
  footerTwip: 567,
  /** pageWidth - 2 * margin = 170 mm, the usable text column. */
  contentWidthTwip: 9638,
  /** The same column in CSS pixels at 96 dpi; images are capped to this. */
  contentWidthPx: A4_CONTENT_WIDTH_PX,
} as const;

/* -------------------------------------------------------------------------- */
/* Labels                                                                      */
/* -------------------------------------------------------------------------- */

export interface DocxLabels {
  /** Heading above the cover-page control table. */
  coverTitle: string;
  docId: string;
  title: string;
  version: string;
  status: string;
  owner: string;
  approver: string;
  adoWorkItem: string;
  classification: string;
  /** Footer pagination, e.g. "Page 1 of 4". */
  page: string;
  of: string;
  /** Shown when a front-matter value is absent. */
  notSet: string;
  /** Visible stand-ins for content the DOCX path cannot render. */
  noticeMermaid: string;
  noticeHtml: string;
  noticeOther: string;
}

const LABELS_EN: DocxLabels = {
  coverTitle: 'Document control',
  docId: 'Document ID',
  title: 'Title',
  version: 'Version',
  status: 'Status',
  owner: 'Document owner',
  approver: 'Approver',
  adoWorkItem: 'ADO work item',
  classification: 'Classification',
  page: 'Page',
  of: 'of',
  notSet: '(not set)',
  noticeMermaid: 'Diagram omitted from this export — see the HTML export for the rendered diagram.',
  noticeHtml: 'Formatted content omitted from this export.',
  noticeOther: 'Unsupported content omitted from this export.',
};

const LABELS_MS: DocxLabels = {
  coverTitle: 'Kawalan dokumen',
  docId: 'ID Dokumen',
  title: 'Tajuk',
  version: 'Versi',
  status: 'Status',
  owner: 'Pemilik Dokumen',
  approver: 'Pelulus',
  adoWorkItem: 'Item Kerja ADO',
  classification: 'Klasifikasi',
  page: 'Halaman',
  of: 'daripada',
  notSet: '(belum ditetapkan)',
  noticeMermaid: 'Gambar rajah ditinggalkan daripada eksport ini — lihat eksport HTML untuk gambar rajah yang dipaparkan.',
  noticeHtml: 'Kandungan berformat ditinggalkan daripada eksport ini.',
  noticeOther: 'Kandungan yang tidak disokong ditinggalkan daripada eksport ini.',
};

/**
 * A bilingual document keeps ENGLISH cover and footer labels: the body carries
 * both languages, and the control table is read by approvers who sign the
 * English column. Only a Bahasa-Malaysia-only document switches labels.
 */
export function labelsFor(lang: DocLang): DocxLabels {
  return lang === 'ms' ? LABELS_MS : LABELS_EN;
}

const STATUS_MS: Record<string, string> = {
  Draft: 'Draf',
  'In Review': 'Dalam Semakan',
  Approved: 'Diluluskan',
  Superseded: 'Diganti',
  Obsolete: 'Lapuk',
  Withdrawn: 'Ditarik Balik',
};

/** Localises the document status; unknown values pass through untouched. */
export function statusLabel(lang: DocLang, value: string): string {
  if (lang !== 'ms') {
    return value;
  }
  return STATUS_MS[value.trim()] ?? value;
}

/* -------------------------------------------------------------------------- */
/* Cover page                                                                  */
/* -------------------------------------------------------------------------- */

export interface CoverRow {
  label: string;
  value: string;
}

export interface ClassificationBanner {
  /** Short form for the running header and footer, e.g. "TERHAD". */
  code: string;
  /** Full sentence for the cover page. */
  text: string;
  /** Hex fill (no '#') for the banner paragraph. */
  fill: string;
}

/** Classifications that must be treated as restricted, not merely non-public. */
const RESTRICTED_CLASSIFICATIONS = new Set(['TERHAD', 'RESTRICTED', 'SULIT', 'SECRET', 'CONFIDENTIAL']);

/**
 * `INTERNAL` (the default) and an empty classification produce no banner — a
 * banner on every document trains readers to ignore it.
 */
export function classificationBanner(meta: DocFrontMatter, labels: DocxLabels): ClassificationBanner | null {
  const code = (meta.classification || '').trim().toUpperCase();
  if (!code || code === 'INTERNAL') {
    return null;
  }
  const text = meta.lang === 'ms' ? `${code} — DOKUMEN TERKAWAL` : `${code} — CONTROLLED DOCUMENT`;
  void labels; // the banner wording above is language-specific, not label-driven
  return { code, text, fill: RESTRICTED_CLASSIFICATIONS.has(code) ? 'F4CCCC' : 'FFF2CC' };
}

/**
 * Rows of the cover-page control table, in reading order. `adoWorkItem` is only
 * present when set — an always-empty row is noise on every template-generated
 * document.
 */
export function buildCoverRows(meta: DocFrontMatter, labels: DocxLabels): CoverRow[] {
  const rows: CoverRow[] = [
    { label: labels.docId, value: meta.docId },
    { label: labels.version, value: meta.version },
    { label: labels.status, value: statusLabel(meta.lang, meta.status) },
    { label: labels.owner, value: meta.owner },
    { label: labels.approver, value: meta.approver },
    { label: labels.classification, value: meta.classification },
  ];
  if (meta.adoWorkItem.trim()) {
    rows.push({ label: labels.adoWorkItem, value: meta.adoWorkItem });
  }
  return rows.map((row) => {
    const value = row.value.trim();
    return { label: row.label, value: value.length > 0 ? value : labels.notSet };
  });
}

/* -------------------------------------------------------------------------- */
/* Running header / footer                                                     */
/* -------------------------------------------------------------------------- */

export type DocxPageField = 'page' | 'pages';

export type FooterSegment = { text: string } | { field: DocxPageField };

export interface DocHeader {
  left: string;
  right: string;
}

/** `DOC-ID · title` on the left, the classification code on the right. */
export function buildHeader(meta: DocFrontMatter, labels: DocxLabels): DocHeader {
  const banner = classificationBanner(meta, labels);
  return {
    left: [meta.docId.trim(), meta.title.trim()].filter((part) => part.length > 0).join(' · '),
    right: banner ? banner.code : '',
  };
}

/**
 * `[CLASSIFICATION · ] DOC-ID · Version 1.0 · Page 1 of 4`
 *
 * Pagination is returned as field markers, not as text: only Word can supply
 * the current page number.
 */
export function buildFooterSegments(meta: DocFrontMatter, labels: DocxLabels): FooterSegment[] {
  const banner = classificationBanner(meta, labels);
  const segments: FooterSegment[] = [];
  if (banner) {
    segments.push({ text: banner.code }, { text: ' · ' });
  }
  segments.push(
    { text: meta.docId.trim() || labels.notSet },
    { text: ' · ' },
    { text: `${labels.version} ${meta.version.trim() || labels.notSet}` },
    { text: ' · ' },
    { text: `${labels.page} ` },
    { field: 'page' },
    { text: ` ${labels.of} ` },
    { field: 'pages' },
  );
  return segments;
}

/* -------------------------------------------------------------------------- */
/* Images                                                                      */
/* -------------------------------------------------------------------------- */

/** The raster formats Word embeds natively (docx's `RegularImageOptions.type`). */
export type DocxRasterType = 'png' | 'jpg' | 'gif' | 'bmp';

/**
 * Structural subset of the host's `ImageAsset`. Declared here rather than
 * imported so this module stays free of the `vscode`-dependent host module and
 * remains trivially testable.
 */
export interface DocxImageAsset {
  refs: string[];
  mime: string;
  format: string;
  /** Already fitted to the content width by the host resolver. */
  width: number;
  height: number;
  base64: string;
}

export interface DocxImageCollection {
  byRef: Record<string, DocxImageAsset>;
}

export type PlannedImage =
  | {
      ok: true;
      key: string;
      base64: string;
      mime: string;
      type: DocxRasterType;
      widthPx: number;
      heightPx: number;
      alt: string;
    }
  | { ok: false; reason: 'missing' | 'unsupported-format' | 'no-dimensions'; ref: string };

/** Maps the host's `ImageFormat` to the value docx requires. */
export function docxImageType(format: string): DocxRasterType | null {
  switch (format) {
    case 'png':
      return 'png';
    case 'jpeg':
    case 'jpg':
      return 'jpg';
    case 'gif':
      return 'gif';
    case 'bmp':
      return 'bmp';
    // WebP and SVG need a raster fallback for Word; they are reported instead
    // of being embedded as a broken picture.
    default:
      return null;
  }
}

export interface ImagePlanResult {
  image: PlannedImage;
  warning?: string;
}

/**
 * Resolves one `![alt](ref)` to embeddable bytes at explicit pixel dimensions.
 *
 * `hintWidthPx` (from `![alt](ref){width=400}` or the template's image markdown)
 * can only NARROW an image — upscaling a 300 px screenshot to 640 px produces
 * the blurred output reviewers complain about.
 */
export function planImage(
  ref: string,
  alt: string,
  hintWidthPx: number | undefined,
  images: DocxImageCollection,
  maxWidthPx: number = DOC_GEOMETRY.contentWidthPx,
): ImagePlanResult {
  const key = (ref || '').trim();
  const asset = key ? images.byRef[key] : undefined;

  if (!asset) {
    return {
      image: { ok: false, reason: 'missing', ref: key },
      warning: `Image not found for export: ${key || '(empty reference)'}`,
    };
  }

  const type = docxImageType(asset.format);
  if (!type) {
    return {
      image: { ok: false, reason: 'unsupported-format', ref: key },
      warning: `Image format "${asset.format}" cannot be embedded in Word — convert ${key} to PNG`,
    };
  }

  if (!(asset.width > 0) || !(asset.height > 0)) {
    return {
      image: { ok: false, reason: 'no-dimensions', ref: key },
      warning: `Image has no usable dimensions: ${key}`,
    };
  }

  const hint = hintWidthPx && hintWidthPx > 0 ? hintWidthPx : asset.width;
  const widthPx = Math.max(1, Math.round(Math.min(hint, asset.width, maxWidthPx)));
  const heightPx = Math.max(1, Math.round((asset.height * widthPx) / asset.width));

  return {
    image: {
      ok: true,
      key,
      base64: asset.base64,
      mime: asset.mime,
      type,
      widthPx,
      heightPx,
      alt: alt || key,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Tables                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Equal columns; the last column absorbs the rounding remainder so the row
 * exactly fills the text column (Word shifts a table that overflows).
 */
export function columnWidths(
  count: number,
  contentWidthTwip: number = DOC_GEOMETRY.contentWidthTwip,
): number[] {
  const n = Math.max(1, Math.floor(count));
  const base = Math.floor(contentWidthTwip / n);
  const widths: number[] = new Array(n).fill(base);
  widths[n - 1] = contentWidthTwip - base * (n - 1);
  return widths;
}

/* -------------------------------------------------------------------------- */
/* Plan                                                                        */
/* -------------------------------------------------------------------------- */

export type PlannedBlock =
  | { kind: 'heading'; level: number; text: string; runs: DocRun[] }
  | { kind: 'paragraph'; runs: DocRun[]; quote: boolean }
  | { kind: 'list'; ordered: boolean; items: DocListItem[] }
  | {
      kind: 'table';
      header: string[];
      rows: string[][];
      align: Array<DocTableAlign | null>;
      columnWidthsTwip: number[];
    }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'image'; image: PlannedImage; alt: string }
  | { kind: 'pagebreak' }
  | { kind: 'rule' }
  /** Visible stand-in for content the DOCX path cannot represent. */
  | { kind: 'notice'; text: string };

export interface DocxPlanOptions {
  /** Defaults to the A4 text column. */
  maxWidthPx?: number;
  /** The running header is omitted for one-page documents. Defaults to true. */
  includeHeader?: boolean;
}

export interface DocxPlan {
  meta: DocFrontMatter;
  labels: DocxLabels;
  geometry: typeof DOC_GEOMETRY;
  cover: {
    title: string;
    rows: CoverRow[];
    banner: ClassificationBanner | null;
  };
  header: DocHeader | null;
  footer: FooterSegment[];
  blocks: PlannedBlock[];
  /** Every reason the exported file will not match the Markdown exactly. */
  warnings: string[];
}

/** Cap for any single image: the A4 text column at 96 dpi. */
export function planDocument(
  parsed: ParsedDoc,
  images: DocxImageCollection,
  options: DocxPlanOptions = {},
): DocxPlan {
  const { meta } = parsed;
  const labels = labelsFor(meta.lang);
  const maxWidthPx = options.maxWidthPx ?? DOC_GEOMETRY.contentWidthPx;
  const warnings: string[] = [];

  // Parser-level findings (missing front-matter keys, unclosed fences, …) are
  // part of the export contract: the caller surfaces one list, not two.
  for (const warning of parsed.warnings) {
    warnings.push(`Line ${warning.line}: ${warning.message}`);
  }

  const blocks: PlannedBlock[] = parsed.blocks.map((block: DocBlock): PlannedBlock => {
    switch (block.kind) {
      case 'heading':
        return { kind: 'heading', level: block.level, text: block.text, runs: block.runs };
      case 'paragraph':
        return { kind: 'paragraph', runs: block.runs, quote: block.quote === true };
      case 'list':
        return { kind: 'list', ordered: block.ordered, items: block.items };
      case 'table':
        return {
          kind: 'table',
          header: block.header,
          rows: block.rows,
          align: block.align,
          columnWidthsTwip: columnWidths(block.header.length),
        };
      case 'code':
        return { kind: 'code', lang: block.lang, text: block.text };
      case 'image': {
        const planned = planImage(block.ref, block.alt, block.widthPx, images, maxWidthPx);
        if (planned.warning) {
          warnings.push(planned.warning);
        }
        return { kind: 'image', image: planned.image, alt: block.alt };
      }
      case 'pagebreak':
        return { kind: 'pagebreak' };
      case 'rule':
        return { kind: 'rule' };
      case 'unsupported': {
        const text = block.raw.trim().length === 0 ? labels.noticeOther : textForUnsupported(block, labels);
        // The parser already reports the same problem with a more actionable
        // message; repeating it here would show two warnings for one omission.
        const alreadyReported = parsed.warnings.some(
          (warning) => warning.line === block.line && warning.code.startsWith('unsupported'),
        );
        if (!alreadyReported) {
          warnings.push(`Line ${block.line}: ${block.reason} content omitted from the DOCX export`);
        }
        return { kind: 'notice', text };
      }
      default:
        // Exhaustive over DocBlock; a new block kind must decide its treatment.
        return { kind: 'notice', text: labels.noticeOther };
    }
  });

  return {
    meta,
    labels,
    geometry: DOC_GEOMETRY,
    cover: {
      title: meta.title.trim() || labels.notSet,
      rows: buildCoverRows(meta, labels),
      banner: classificationBanner(meta, labels),
    },
    header: options.includeHeader === false ? null : buildHeader(meta, labels),
    footer: buildFooterSegments(meta, labels),
    blocks,
    warnings,
  };
}

function textForUnsupported(
  block: Extract<DocBlock, { kind: 'unsupported' }>,
  labels: DocxLabels,
): string {
  switch (block.reason) {
    case 'mermaid':
      return labels.noticeMermaid;
    case 'html':
      return labels.noticeHtml;
    default:
      return labels.noticeOther;
  }
}
