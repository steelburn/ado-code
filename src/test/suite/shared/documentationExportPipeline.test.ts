import * as assert from 'assert';
import {
  EXPORT_MIME,
  buildDocxImages,
  describeExportSuccess,
  exportFormatNoun,
  exportSavePlan,
  formatDocBlockWarning,
  formatExportWarning,
  rasterizedImageAsset,
} from '../../../shared/documentation/exportPipeline';
import type {
  DiagramExportPayload,
  DocxExportPayload,
  ExportedImageAsset,
  RegisterExportPayload,
} from '../../../shared/documentation/exportPayload';
import { PNG_DATA_URI_PREFIX } from '../../../shared/svgRaster';

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AARAAI/AL+2wAAAABJRU5ErkJggg==';

function asset(overrides: Partial<ExportedImageAsset> = {}): ExportedImageAsset {
  return {
    refs: ['assets/img/shot.png'],
    filePath: 'C:/proj/assets/img/shot.png',
    relativePath: 'assets/img/shot.png',
    mime: 'image/png',
    format: 'png',
    width: 320,
    height: 200,
    originalWidth: 640,
    originalHeight: 400,
    base64: PNG_1PX,
    ...overrides,
  } as ExportedImageAsset;
}

const DOCX_PAYLOAD = {
  ok: true,
  format: 'docx',
  projectPath: 'C:/proj',
  documentPath: 'C:/proj/01-design/srs.md',
  relativePath: '01-design/srs.md',
  markdown: '# SRS',
  images: [],
  suggestedFileName: 'srs.docx',
  defaultDir: 'export/out',
  warnings: [],
} as DocxExportPayload;

const XLSX_PAYLOAD = {
  ok: true,
  format: 'xlsx',
  projectName: 'proj',
  role: 'Tester',
  record: {},
  sources: [],
  present: [],
  missing: [],
  suggestedFileName: 'proj-registers.xlsx',
  defaultDir: 'export/out',
  warnings: [],
} as unknown as RegisterExportPayload;

const DIAGRAM_PAYLOAD = {
  ok: true,
  format: 'diagram-png',
  projectPath: 'C:/proj',
  documentPath: 'C:/proj/01-design/system-design.md',
  relativePath: '01-design/system-design.md',
  line: 12,
  index: 0,
  code: 'graph TD; A-->B;',
  title: 'Context',
  suggestedFileName: 'context.png',
  defaultDir: 'export/out',
  warnings: [],
} as DiagramExportPayload;

suite('documentation export pipeline — save plans', () => {
  test('MIME types are the real Office values, not octet-stream', () => {
    assert.strictEqual(EXPORT_MIME.docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.strictEqual(EXPORT_MIME.xlsx, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.strictEqual(EXPORT_MIME['diagram-png'], 'image/png');
  });

  test('the save plan carries the host’s file name and folder verbatim', () => {
    const plan = exportSavePlan('docx', 'AAA', DOCX_PAYLOAD);
    assert.deepStrictEqual(plan, {
      content: 'AAA',
      mime: EXPORT_MIME.docx,
      defaultName: 'srs.docx',
      defaultDir: 'export/out',
    });
  });

  test('each format maps to its own plan', () => {
    assert.strictEqual(exportSavePlan('xlsx', 'x', XLSX_PAYLOAD).mime, EXPORT_MIME.xlsx);
    assert.strictEqual(exportSavePlan('diagram-png', 'x', DIAGRAM_PAYLOAD).mime, 'image/png');
    assert.strictEqual(exportSavePlan('diagram-png', 'x', DIAGRAM_PAYLOAD).defaultName, 'context.png');
  });

  test('format nouns read as prose fragments', () => {
    assert.strictEqual(exportFormatNoun('docx'), 'Word document');
    assert.strictEqual(exportFormatNoun('xlsx'), 'register workbook');
    assert.strictEqual(exportFormatNoun('diagram-png'), 'diagram');
  });
});

suite('documentation export pipeline — docx images', () => {
  test('every reference of an asset resolves to the same entry', () => {
    const collection = buildDocxImages([
      asset({ refs: ['assets/img/shot.png', './assets/img/shot.png'] }),
    ]);
    assert.strictEqual(Object.keys(collection.byRef).length, 2);
    assert.strictEqual(collection.byRef['assets/img/shot.png'], collection.byRef['./assets/img/shot.png']);
  });

  test('the entry keeps the fitted dimensions, not the intrinsic ones', () => {
    const collection = buildDocxImages([asset()]);
    const entry = collection.byRef['assets/img/shot.png'];
    assert.strictEqual(entry.width, 320);
    assert.strictEqual(entry.height, 200);
    assert.strictEqual(entry.base64, PNG_1PX);
    assert.strictEqual(entry.mime, 'image/png');
  });

  test('an asset with no bytes is skipped rather than embedded empty', () => {
    const collection = buildDocxImages([asset({ base64: '' })]);
    assert.deepStrictEqual(collection.byRef, {});
  });

  test('a rasterised diagram becomes an image entry keyed by its data URI', () => {
    const ref = `${PNG_DATA_URI_PREFIX}${PNG_1PX}`;
    const collection = buildDocxImages([], [{ line: 4, ref, caption: 'Flow', width: 400, height: 300 }]);

    const entry = collection.byRef[ref];
    assert.ok(entry, 'diagram ref must be resolvable by planDocument');
    assert.strictEqual(entry.base64, PNG_1PX);
    assert.strictEqual(entry.mime, 'image/png');
    assert.strictEqual(entry.format, 'png');
    assert.strictEqual(entry.width, 400);
  });

  test('disk assets and diagrams live in one lookup', () => {
    const ref = `${PNG_DATA_URI_PREFIX}${PNG_1PX}`;
    const collection = buildDocxImages([asset()], [{ line: 4, ref, caption: 'Flow', width: 10, height: 10 }]);
    assert.deepStrictEqual(Object.keys(collection.byRef), ['assets/img/shot.png', ref]);
  });

  test('missing diagram dimensions become zero, which the plan reports', () => {
    const ref = `${PNG_DATA_URI_PREFIX}${PNG_1PX}`;
    const entry = rasterizedImageAsset({ line: 4, ref, caption: 'Flow' });
    assert.strictEqual(entry?.width, 0);
    assert.strictEqual(entry?.height, 0);
  });

  test('a non-PNG data URI is not accepted as a diagram image', () => {
    assert.strictEqual(
      rasterizedImageAsset({ line: 4, ref: 'data:image/svg+xml;base64,AAAA', caption: 'Flow' }),
      null,
    );
  });

  test('an empty PNG payload is rejected rather than embedded', () => {
    assert.strictEqual(rasterizedImageAsset({ line: 4, ref: PNG_DATA_URI_PREFIX, caption: 'Flow' }), null);
    assert.strictEqual(rasterizedImageAsset({ line: 4, ref: '', caption: 'Flow' }), null);
  });
});

suite('documentation export pipeline — warning formatting', () => {
  test('a parser warning keeps its line number', () => {
    assert.strictEqual(
      formatDocBlockWarning({ line: 87, message: 'mermaid omitted' }),
      'Line 87: mermaid omitted',
    );
  });

  test('a warning without a line stands alone', () => {
    assert.strictEqual(formatDocBlockWarning({ line: 0, message: 'front matter missing' }), 'front matter missing');
  });

  test('a workbook warning names its sheet, row and column', () => {
    assert.strictEqual(
      formatExportWarning({ message: 'Unknown value', sheet: 'Executions', row: 12, column: 'RESULT' }),
      'Unknown value [Executions, row 12, column RESULT]',
    );
  });

  test('partial locations degrade cleanly', () => {
    assert.strictEqual(formatExportWarning({ message: 'Truncated', column: 'NOTES' }), 'Truncated [column NOTES]');
    assert.strictEqual(formatExportWarning({ message: 'Truncated' }), 'Truncated');
    assert.strictEqual(formatExportWarning({ message: 'Zero row', row: 0 }), 'Zero row');
  });
});

suite('documentation export pipeline — outcome wording', () => {
  test('a clean export names the file and the format', () => {
    assert.strictEqual(
      describeExportSuccess('docx', DOCX_PAYLOAD),
      'Built srs.docx (Word document)',
    );
  });

  test('warnings are counted, not listed', () => {
    assert.strictEqual(
      describeExportSuccess('xlsx', XLSX_PAYLOAD, ['a', 'b']),
      'Built proj-registers.xlsx (register workbook) — 2 warning(s)',
    );
  });
});
