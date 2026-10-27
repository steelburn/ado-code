import * as assert from 'assert';
import {
  DEFAULT_EXPORT_DIR,
  DOCUMENTATION_EXPORT_FORMATS,
  describeExportPayload,
  diagramFileName,
  docxFileName,
  exportFormatLabel,
  indexAssetsByRef,
  isDocumentationExportFormat,
  normaliseExportRequest,
  stemOf,
  xlsxFileName,
  ExportedImageAsset,
} from '../../../shared/documentation/exportPayload';

function asset(overrides: Partial<ExportedImageAsset> = {}): ExportedImageAsset {
  return {
    refs: ['assets/img/a.png'],
    filePath: 'C:/proj/assets/img/a.png',
    relativePath: 'assets/img/a.png',
    mime: 'image/png',
    format: 'png',
    width: 640,
    height: 480,
    originalWidth: 1280,
    originalHeight: 960,
    base64: 'AAAA',
    ...overrides,
  };
}

suite('documentation export payload — request validation', () => {
  test('accepts an xlsx request and drops the document path', () => {
    const check = normaliseExportRequest({
      projectPath: '  C:/proj  ',
      format: 'xlsx',
      documentPath: 'ignored.md',
      // an unknown field must not survive the boundary
      runShellCommand: 'rm -rf /',
    });
    assert.strictEqual(check.ok, true);
    if (!check.ok) return;
    assert.deepStrictEqual(check.request, { projectPath: 'C:/proj', format: 'xlsx' });
    assert.ok(!('documentPath' in check.request));
    assert.ok(!('runShellCommand' in check.request));
  });

  test('accepts a docx request with a document path', () => {
    const check = normaliseExportRequest({
      projectPath: 'C:/proj',
      format: 'docx',
      documentPath: '04-user-docs/user-manual.md',
    });
    assert.strictEqual(check.ok, true);
    if (!check.ok) return;
    assert.strictEqual(check.request.documentPath, '04-user-docs/user-manual.md');
    assert.strictEqual(check.request.diagramLine, undefined);
  });

  test('accepts a diagram request with a positive integer line', () => {
    const check = normaliseExportRequest({
      projectPath: 'C:/proj',
      format: 'diagram-png',
      documentPath: 'a.md',
      diagramLine: 42,
    });
    assert.strictEqual(check.ok, true);
    if (!check.ok) return;
    assert.strictEqual(check.request.diagramLine, 42);
  });

  test('rejects a non-object request', () => {
    for (const raw of [null, undefined, 'xlsx', 7, []]) {
      const check = normaliseExportRequest(raw as unknown);
      assert.strictEqual(check.ok, false, `expected ${String(raw)} to be rejected`);
    }
  });

  test('rejects a missing or blank project path', () => {
    for (const projectPath of [undefined, '', '   ', 42]) {
      const check = normaliseExportRequest({ projectPath, format: 'xlsx' } as unknown);
      assert.strictEqual(check.ok, false);
      if (check.ok) return;
      assert.match(check.error, /project folder/i);
    }
  });

  test('rejects a path containing a NUL byte', () => {
    const check = normaliseExportRequest({ projectPath: 'C:/pro\u0000j', format: 'xlsx' });
    assert.strictEqual(check.ok, false);
  });

  test('rejects an unknown format and says which one', () => {
    const check = normaliseExportRequest({ projectPath: 'C:/proj', format: 'pdf' });
    assert.strictEqual(check.ok, false);
    if (check.ok) return;
    assert.match(check.error, /pdf/);
  });

  test('docx and diagram formats require a document path', () => {
    for (const format of ['docx', 'diagram-png']) {
      const check = normaliseExportRequest({ projectPath: 'C:/proj', format });
      assert.strictEqual(check.ok, false, `${format} without a document`);
      if (check.ok) return;
      assert.match(check.error, /Markdown document/i);
    }
  });

  test('diagram line is optional but must be a positive integer when given', () => {
    const omitted = normaliseExportRequest({
      projectPath: 'C:/proj',
      format: 'diagram-png',
      documentPath: 'a.md',
    } as unknown);
    assert.strictEqual(omitted.ok, true, 'omitting the line means "the first diagram"');
    if (omitted.ok && omitted.request.format === 'diagram-png') {
      assert.strictEqual(omitted.request.diagramLine, undefined);
    }

    for (const diagramLine of [0, -3, 1.5, '4', NaN]) {
      const check = normaliseExportRequest({
        projectPath: 'C:/proj',
        format: 'diagram-png',
        documentPath: 'a.md',
        diagramLine,
      } as unknown);
      assert.strictEqual(check.ok, false, `line ${String(diagramLine)} should be rejected`);
    }
  });

  test('format guard matches the advertised list', () => {
    assert.deepStrictEqual([...DOCUMENTATION_EXPORT_FORMATS], ['xlsx', 'docx', 'diagram-png']);
    for (const format of DOCUMENTATION_EXPORT_FORMATS) {
      assert.strictEqual(isDocumentationExportFormat(format), true);
    }
    for (const value of [undefined, null, 1, '', 'PDF', 'xlsx ']) {
      assert.strictEqual(isDocumentationExportFormat(value), false);
    }
  });

  test('export output goes to the gitignored export folder', () => {
    assert.strictEqual(DEFAULT_EXPORT_DIR, 'export/out');
  });
});

suite('documentation export payload — file naming', () => {
  test('stemOf takes the last segment without its extension', () => {
    assert.strictEqual(stemOf('04-user-docs/user-manual.md'), 'user-manual');
    assert.strictEqual(stemOf('04-user-docs\\user-manual.md'), 'user-manual');
    assert.strictEqual(stemOf('user.manual.md'), 'user.manual');
    assert.strictEqual(stemOf('README'), 'README');
    assert.strictEqual(stemOf('.hidden'), '.hidden');
  });

  test('docx name mirrors the source document', () => {
    assert.strictEqual(docxFileName('04-user-docs/user-manual.md'), 'user-manual.docx');
    assert.strictEqual(docxFileName('a/My Manual.md'), 'My-Manual.docx');
  });

  test('a document with no usable name still yields a file name', () => {
    assert.strictEqual(docxFileName('///'), 'document.docx');
    assert.strictEqual(xlsxFileName(''), 'documentation-registers.xlsx');
  });

  test('diagram names are 1-based and also used as a fallback', () => {
    assert.strictEqual(diagramFileName('docs/a.md', 1), 'a-diagram-1.png');
    assert.strictEqual(diagramFileName('docs/a.md', 3), 'a-diagram-3.png');
    // out-of-range indices fall back to 1 rather than producing "-0" or "NaN"
    assert.strictEqual(diagramFileName('docs/a.md', 0), 'a-diagram-1.png');
    assert.strictEqual(diagramFileName('docs/a.md', Number.NaN), 'a-diagram-1.png');
  });

  test('windows-illegal characters never reach a file name', () => {
    assert.strictEqual(docxFileName('docs/a<b>c:d"e|f?g*h.md'), 'a-b-c-d-e-f-g-h.docx');
  });

  test('xlsx name comes from the project name', () => {
    assert.strictEqual(xlsxFileName('e-Government Portal'), 'e-Government-Portal-registers.xlsx');
  });
});

suite('documentation export payload — presentation helpers', () => {
  test('every format has a human label', () => {
    assert.strictEqual(exportFormatLabel('xlsx'), 'Excel workbook');
    assert.strictEqual(exportFormatLabel('docx'), 'Word document');
    assert.strictEqual(exportFormatLabel('diagram-png'), 'Diagram PNG');
  });

  test('describeExportPayload summarises success and failure', () => {
    assert.strictEqual(
      describeExportPayload({
        ok: false,
        format: 'docx',
        error: 'Could not read a.md.',
        warnings: [],
      }),
      'Could not read a.md.',
    );
    assert.match(
      describeExportPayload({
        ok: true,
        format: 'xlsx',
        projectName: 'p',
        role: 'BA',
        record: {},
        sources: [
          { kind: 'rtm', csv: 'a,b' },
          { kind: 'media', csv: 'a,b' },
        ],
        present: ['rtm', 'media'],
        missing: [],
        suggestedFileName: 'p-registers.xlsx',
        defaultDir: DEFAULT_EXPORT_DIR,
        warnings: [],
      }),
      /2 register/,
    );
    assert.match(
      describeExportPayload({
        ok: true,
        format: 'diagram-png',
        projectPath: 'p',
        documentPath: 'p/a.md',
        relativePath: 'a.md',
        line: 3,
        index: 0,
        code: 'graph TD; A-->B;',
        title: 'To-be flow',
        suggestedFileName: 'a-diagram-1.png',
        defaultDir: DEFAULT_EXPORT_DIR,
        warnings: [],
      }),
      /To-be flow/,
    );
  });
});

suite('documentation export payload — image index', () => {
  test('an asset is reachable through every reference that resolved to it', () => {
    const a = asset({ refs: ['assets/img/a.png', './assets/img/a.png'] });
    const b = asset({ refs: ['assets/img/b.png'], relativePath: 'assets/img/b.png' });
    const byRef = indexAssetsByRef([a, b]);

    assert.deepStrictEqual(Object.keys(byRef).sort(), [
      './assets/img/a.png',
      'assets/img/a.png',
      'assets/img/b.png',
    ]);
    assert.strictEqual(byRef['./assets/img/a.png'], a);
    assert.strictEqual(byRef['assets/img/b.png'], b);
  });

  test('an empty asset list yields an empty index, not undefined', () => {
    assert.deepStrictEqual(indexAssetsByRef([]), {});
  });
});
