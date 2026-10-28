import * as path from 'path';
import * as vscode from 'vscode';
import {
  A4_CONTENT_WIDTH_PX,
  fitToContentWidth,
  formatToMime,
  imageSize,
  sniffImageFormat,
  type ImageFormat,
} from '../shared/imageSize';

/**
 * imageAssets — host-side resolution of the image references found in a
 * documentation project into concrete bytes the exporters can embed.
 *
 * The DOCX renderer runs in the webview and cannot read the filesystem, so the
 * host resolves every `![alt](ref)` up front and ships base64 down in one
 * message. Doing it in a single pass has three benefits that matter for these
 * templates:
 *   - every missing image is reported *before* an export is produced, as a
 *     warning, instead of failing (or silently dropping content) mid-render;
 *   - each file is read and sniffed exactly once, even when the same figure
 *     appears in several documents;
 *   - the intrinsic size is measured from the file header, so `docx` gets the
 *     explicit pixel dimensions it needs to lay the image out on an A4 page.
 *
 * Nothing here throws on bad input: an unresolvable reference becomes an
 * `ImageIssue`, because a documentation export that aborts on one broken
 * screenshot is worse than one that names the broken screenshot.
 */

/** Per-image ceiling. Above this a reference is skipped with a warning. */
export const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export type ImageIssueCode =
  | 'empty-ref'
  | 'remote'
  | 'missing'
  | 'unreadable'
  | 'too-large'
  | 'unsupported-format'
  | 'no-dimensions'
  | 'outside-project';

export interface ImageIssue {
  /** The reference exactly as it appeared in the Markdown (trimmed). */
  ref: string;
  code: ImageIssueCode;
  message: string;
}

export interface ImageAsset {
  /** Every reference in the document set that resolves to this file. */
  refs: string[];
  /** Absolute path on disk; empty for inline `data:` images. */
  filePath: string;
  /** Path relative to the project folder; empty for inline images. */
  relativePath: string;
  mime: string;
  format: ImageFormat;
  /** Intrinsic pixel size as measured from the file header. */
  originalWidth: number;
  originalHeight: number;
  /** Pixel size after capping to the content width — what the renderer should use. */
  width: number;
  height: number;
  bytes: number;
  base64: string;
}

export interface ImageAssetCollection {
  assets: ImageAsset[];
  issues: ImageIssue[];
  /** One human-readable line per issue — ready to surface in a toast or log. */
  warnings: string[];
  /**
   * Lookup by reference. Plain object (not a Map) so the caller can post the
   * collection through `postMessage` without rebuilding it.
   */
  byRef: Record<string, ImageAsset>;
}

export interface CollectImageAssetsOptions {
  /** Absolute path of the Markdown document whose image references are resolved. */
  documentPath: string;
  refs: string[];
  /**
   * Folder that bounds what may be read. Defaults to the document's own folder;
   * pass the project root so `assets/` references from a nested `export/` script
   * still resolve while `../../secrets` does not.
   */
  projectRoot?: string;
  maxBytes?: number;
  maxWidthPx?: number;
  /** Injected for tests; defaults to `vscode.workspace.fs.readFile`. */
  readFile?: (filePath: string) => Promise<Uint8Array>;
  /** Injected for tests; returning undefined skips the pre-read size check. */
  statSize?: (filePath: string) => Promise<number | undefined>;
}

/* ------------------------------------------------------------------ */
/* defaults                                                            */
/* ------------------------------------------------------------------ */

async function defaultReadFile(filePath: string): Promise<Uint8Array> {
  return vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
}

async function defaultStatSize(filePath: string): Promise<number | undefined> {
  const fsApi = (vscode.workspace as unknown as { fs?: { stat?: (uri: vscode.Uri) => Promise<{ size: number }> } }).fs;
  if (!fsApi || typeof fsApi.stat !== 'function') {
    return undefined;
  }
  try {
    const stat = await fsApi.stat(vscode.Uri.file(filePath));
    return typeof stat?.size === 'number' ? stat.size : undefined;
  } catch {
    // A missing file is reported by the subsequent read, with a better message.
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* reference normalisation                                             */
/* ------------------------------------------------------------------ */

const REMOTE_REF_RE = /^[a-z][a-z0-9+.-]*:/i;
const DATA_URI_RE = /^data:([^;,]*)(;base64)?,([\s\S]*)$/i;
const MARKDOWN_TITLE_RE = /\s+(?:"[^"]*"|'[^']*')\s*$/;

/**
 * Trim a Markdown image destination: drop an optional title, unwrap the
 * angle-bracket form used for paths with spaces, and percent-decode. A malformed
 * escape sequence (a literal `%` in a Windows path) is left untouched.
 * Protocol-relative (`//host/path`) references are left for the caller to reject
 * as remote — they are absolute URLs without a scheme.
 */
export function normaliseImageRef(raw: string): string {
  let ref = (raw ?? '').trim();
  if (!ref) {
    return '';
  }
  ref = ref.replace(MARKDOWN_TITLE_RE, '').trim();
  if (ref.startsWith('<') && ref.endsWith('>')) {
    ref = ref.slice(1, -1).trim();
  }
  try {
    ref = decodeURIComponent(ref);
  } catch {
    // keep the raw text
  }
  return ref;
}

function parseDataUri(ref: string): { mime: string; bytes: Uint8Array } | null {
  const match = DATA_URI_RE.exec(ref);
  if (!match) {
    return null;
  }
  const mime = (match[1] || 'text/plain').toLowerCase();
  const payload = match[3] ?? '';
  if (match[2]) {
    try {
      return { mime, bytes: new Uint8Array(Buffer.from(payload, 'base64')) };
    } catch {
      return null;
    }
  }
  try {
    return { mime, bytes: new TextEncoder().encode(decodeURIComponent(payload)) };
  } catch {
    return null;
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (code === 'ENOENT' || code === 'FileNotFound') {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /ENOENT|not\s*found|no such file/i.test(message);
}

/* ------------------------------------------------------------------ */
/* diagnostics                                                         */
/* ------------------------------------------------------------------ */

export function formatImageIssue(issue: ImageIssue, maxBytes: number = DEFAULT_MAX_IMAGE_BYTES): string {
  switch (issue.code) {
    case 'empty-ref':
      return 'An image has no file reference';
    case 'remote':
      return `Remote image not embedded: ${issue.ref}`;
    case 'missing':
      return `Image not found: ${issue.ref}`;
    case 'unreadable':
      return `Image could not be read: ${issue.ref}`;
    case 'too-large':
      return `Image is larger than ${Math.round(maxBytes / (1024 * 1024))} MB and was skipped: ${issue.ref}`;
    case 'unsupported-format':
      return `Unsupported image format: ${issue.ref} (use PNG, JPEG, GIF, WebP, BMP or SVG)`;
    case 'no-dimensions':
      return `Image dimensions could not be determined: ${issue.ref}`;
    case 'outside-project':
      return `Image is outside the project folder and was skipped: ${issue.ref}`;
    default:
      return issue.message;
  }
}

/* ------------------------------------------------------------------ */
/* collection                                                          */
/* ------------------------------------------------------------------ */

export async function collectImageAssets(options: CollectImageAssetsOptions): Promise<ImageAssetCollection> {
  const documentDir = path.dirname(path.resolve(options.documentPath));
  const projectRoot = path.resolve(options.projectRoot ?? documentDir);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const maxWidthPx = options.maxWidthPx ?? A4_CONTENT_WIDTH_PX;
  const readFile = options.readFile ?? defaultReadFile;
  const statSize = options.statSize ?? defaultStatSize;

  const assets: ImageAsset[] = [];
  const issues: ImageIssue[] = [];
  const byRef: Record<string, ImageAsset> = {};
  const assetByPath = new Map<string, ImageAsset>();

  const report = (ref: string, code: ImageIssueCode, message: string): void => {
    issues.push({ ref, code, message });
  };

  for (const raw of options.refs ?? []) {
    const ref = normaliseImageRef(raw);
    if (!ref) {
      report((raw ?? '').trim(), 'empty-ref', 'An image has no file reference');
      continue;
    }
    if (byRef[ref]) {
      continue;
    }

    const inline = parseDataUri(ref);
    if (inline) {
      const inlineAsset = addAsset({
        ref,
        filePath: '',
        relativePath: '',
        bytes: inline.bytes,
        maxBytes,
        maxWidthPx,
        assets,
        report,
      });
      if (inlineAsset) {
        byRef[ref] = inlineAsset;
      }
      continue;
    }

    if (REMOTE_REF_RE.test(ref) || ref.startsWith('//')) {
      report(ref, 'remote', 'Remote images are not downloaded');
      continue;
    }

    const filePath = path.isAbsolute(ref) ? path.normalize(ref) : path.resolve(documentDir, ref);
    if (!isInside(projectRoot, filePath)) {
      report(ref, 'outside-project', 'Path escapes the project folder');
      continue;
    }

    const existing = assetByPath.get(filePath);
    if (existing) {
      existing.refs.push(ref);
      byRef[ref] = existing;
      continue;
    }

    let bytes: Uint8Array;
    try {
      const size = await statSize(filePath);
      if (typeof size === 'number' && size > maxBytes) {
        report(ref, 'too-large', `${size} bytes exceeds the ${maxBytes} byte limit`);
        continue;
      }
      bytes = await readFile(filePath);
    } catch (error) {
      if (isNotFound(error)) {
        report(ref, 'missing', error instanceof Error ? error.message : 'file not found');
      } else {
        report(ref, 'unreadable', error instanceof Error ? error.message : String(error));
      }
      continue;
    }

    const asset = addAsset({
      ref,
      filePath,
      relativePath: path.relative(projectRoot, filePath).split(path.sep).join('/'),
      bytes,
      maxBytes,
      maxWidthPx,
      assets,
      report,
    });
    if (asset) {
      assetByPath.set(filePath, asset);
      byRef[ref] = asset;
    }
  }

  return {
    assets,
    issues,
    warnings: issues.map(issue => formatImageIssue(issue, maxBytes)),
    byRef,
  };
}

interface AddAssetArgs {
  ref: string;
  filePath: string;
  relativePath: string;
  bytes: Uint8Array;
  maxBytes: number;
  maxWidthPx: number;
  assets: ImageAsset[];
  report: (ref: string, code: ImageIssueCode, message: string) => void;
}

function addAsset(args: AddAssetArgs): ImageAsset | null {
  const { ref, bytes, maxBytes, maxWidthPx, assets, report } = args;
  if (bytes.byteLength === 0) {
    report(ref, 'unreadable', 'File is empty');
    return null;
  }
  if (bytes.byteLength > maxBytes) {
    report(ref, 'too-large', `${bytes.byteLength} bytes exceeds the ${maxBytes} byte limit`);
    return null;
  }

  const format = sniffImageFormat(bytes);
  if (format === 'unknown') {
    report(ref, 'unsupported-format', 'Unrecognised image signature');
    return null;
  }

  const size = imageSize(bytes);
  if (!size) {
    report(ref, 'no-dimensions', 'Header does not expose an intrinsic size');
    return null;
  }

  const fitted = fitToContentWidth(size.width, size.height, maxWidthPx);
  const asset: ImageAsset = {
    refs: [ref],
    filePath: args.filePath,
    relativePath: args.relativePath,
    mime: formatToMime(size.format),
    format: size.format,
    originalWidth: size.width,
    originalHeight: size.height,
    width: fitted.width,
    height: fitted.height,
    bytes: bytes.byteLength,
    base64: Buffer.from(bytes).toString('base64'),
  };
  assets.push(asset);
  return asset;
}
