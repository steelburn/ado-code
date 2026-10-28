/**
 * xlsxRenderer — turns the dependency-free workbook model into real `.xlsx`
 * bytes using the ZIP layer the webview already carries for `docx`.
 *
 * Everything decision-like lives in `src/shared/xlsx.ts` and is unit tested
 * there against the emitted XML parts; this module is only the archive step
 * (`fflate.zipSync`) plus base64, which is the shape the host save bridge
 * already speaks.
 *
 * `fflate` is imported directly rather than lazily here: the caller awaits
 * `import()` of THIS module, so the dependency and its ZIP tables land in their
 * own chunk and stay off the activation path of anything that never exports a
 * register.
 */

import { zipSync } from 'fflate';
import {
  XLSX_MIME,
  bytesToBase64,
  serializeXlsx,
  type XlsxWarning,
  type XlsxWorkbook,
} from '../../../shared/xlsx';

export { XLSX_MIME };

export interface RenderedWorkbook {
  /** The `.xlsx` bytes. */
  bytes: Uint8Array;
  /** The same bytes as base64, ready for the `saveBinary` message. */
  base64: string;
  warnings: XlsxWarning[];
  /** Sheet names as finally written (Excel-legal, de-duplicated). */
  sheetNames: string[];
}

/** ZIP level 6 is the usual size/speed knee and matches Excel's own output closely. */
const ZIP_LEVEL = 6;

/**
 * Renders a workbook to `.xlsx`.
 *
 * The archive timestamp is pinned to the workbook's own `generatedAt` (falling
 * back to the Unix epoch, not "now") so exporting the same registers twice
 * produces byte-identical files — which is what makes "did the export change?"
 * a meaningful question in review.
 */
export function renderXlsx(workbook: XlsxWorkbook): RenderedWorkbook {
  const stamp =
    workbook.generatedAt && !Number.isNaN(workbook.generatedAt.getTime())
      ? workbook.generatedAt
      : new Date(0);

  const serialized = serializeXlsx(workbook, (files) =>
    zipSync(files, { level: ZIP_LEVEL, mtime: stamp }),
  );

  return {
    bytes: serialized.bytes,
    base64: bytesToBase64(serialized.bytes),
    warnings: serialized.warnings,
    sheetNames: serialized.sheetNames,
  };
}
