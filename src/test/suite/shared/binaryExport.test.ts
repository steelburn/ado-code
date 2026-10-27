import * as assert from 'assert';
import {
  MAX_FILTERS,
  buildSaveFilters,
  describeBytes,
  ensureExtension,
  extensionForMime,
  filterLabel,
  normaliseDefaultDir,
  normaliseMime,
  planBinarySave,
  sanitiseFileName,
  stripBase64Prefix,
  validateBase64Payload,
} from '../../../shared/binaryExport';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Base64 of a real ZIP header — the shortest payload we can sanity-check. */
const ZIP4 = 'UEsDBA==';

suite('binaryExport — mime handling', () => {
  test('normalises case and drops parameters', () => {
    assert.strictEqual(normaliseMime('IMAGE/PNG'), 'image/png');
    assert.strictEqual(normaliseMime('text/csv; charset=utf-8'), 'text/csv');
    assert.strictEqual(normaliseMime('  application/pdf  '), 'application/pdf');
  });

  test('an empty mime stays empty (caller falls back to the file name)', () => {
    assert.strictEqual(normaliseMime(''), '');
    assert.strictEqual(normaliseMime(undefined as unknown as string), '');
  });

  test('maps every format the exporters emit', () => {
    assert.strictEqual(extensionForMime(DOCX), 'docx');
    assert.strictEqual(extensionForMime(XLSX), 'xlsx');
    assert.strictEqual(extensionForMime('image/png'), 'png');
    assert.strictEqual(extensionForMime('image/jpeg'), 'jpg');
    assert.strictEqual(extensionForMime('image/svg+xml'), 'svg');
    assert.strictEqual(extensionForMime('text/csv'), 'csv');
    assert.strictEqual(extensionForMime('application/json'), 'json');
  });

  test('an unknown mime has no extension', () => {
    assert.strictEqual(extensionForMime('application/x-made-up'), undefined);
  });

  test('filter labels are human, not extensions', () => {
    assert.strictEqual(filterLabel('docx'), 'Word document');
    assert.strictEqual(filterLabel('XLSX'), 'Excel workbook');
    assert.strictEqual(filterLabel('qqq'), 'QQQ file');
  });
});

suite('binaryExport — base64 payload validation', () => {
  test('reports the decoded byte count', () => {
    for (const payload of [ZIP4, 'AAAA', 'AA==', 'AAA=', 'AAAAAA', '']) {
      const expected = payload ? Buffer.from(payload, 'base64').length : 0;
      const result = validateBase64Payload(payload);
      assert.strictEqual(result.bytes, expected, `byte count for ${JSON.stringify(payload)}`);
    }
  });

  test('an empty payload is refused with a user-facing message', () => {
    const result = validateBase64Payload('   \n ');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'empty');
    assert.ok(result.message && /nothing to save/i.test(result.message), result.message);
  });

  test('non-base64 characters are refused', () => {
    const result = validateBase64Payload('UEsD BA$==');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'not-base64');
  });

  test('a length remainder of 1 is impossible in base64 and refused', () => {
    assert.strictEqual(validateBase64Payload('AAAAA').ok, false);
    assert.strictEqual(validateBase64Payload('AAAAA').reason, 'not-base64');
  });

  test('unpadded payloads are accepted (not every producer pads)', () => {
    const result = validateBase64Payload('AAAAAA');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.bytes, 4);
  });

  test('whitespace and newlines inside the payload are ignored', () => {
    const result = validateBase64Payload('UEsD\nBA==\n');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.bytes, 4);
  });

  test('a data: URI prefix is stripped rather than written into the file', () => {
    assert.strictEqual(stripBase64Prefix('data:image/png;base64,UEsDBA=='), ZIP4);
    const result = validateBase64Payload('data:image/png;base64,UEsDBA==');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.bytes, 4);
  });

  test('a payload above the limit is refused and names both sizes', () => {
    const result = validateBase64Payload(ZIP4, 2);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'too-large');
    assert.ok(result.message && /4 B/.test(result.message), result.message);
    assert.ok(result.message && /2 B/.test(result.message), result.message);
  });

  test('the limit is inclusive — a payload exactly at maxBytes is allowed', () => {
    assert.strictEqual(validateBase64Payload(ZIP4, 4).ok, true);
  });
});

suite('binaryExport — file names', () => {
  test('path separators cannot pass through', () => {
    assert.strictEqual(sanitiseFileName('../../etc/passwd'), 'passwd');
    assert.strictEqual(sanitiseFileName('C:\\Windows\\evil.docx'), 'evil.docx');
    assert.strictEqual(sanitiseFileName('folder/sub/report.xlsx'), 'report.xlsx');
  });

  test('characters Windows rejects are stripped', () => {
    assert.strictEqual(sanitiseFileName('re:port*?<>.docx'), 'report.docx');
    assert.strictEqual(sanitiseFileName('tab\there.docx'), 'tabhere.docx');
  });

  test('reserved device names are defused', () => {
    assert.strictEqual(sanitiseFileName('CON'), '_CON');
    assert.strictEqual(sanitiseFileName('con.docx'), '_con.docx');
    assert.strictEqual(sanitiseFileName('LPT1.docx'), '_LPT1.docx');
    assert.strictEqual(sanitiseFileName('console.docx'), 'console.docx');
  });

  test('leading and trailing dots/spaces are removed', () => {
    assert.strictEqual(sanitiseFileName('  ..hidden..  '), 'hidden');
  });

  test('an empty suggestion falls back to a usable name', () => {
    assert.strictEqual(sanitiseFileName(''), 'export');
    assert.strictEqual(sanitiseFileName(undefined), 'export');
    assert.strictEqual(sanitiseFileName('...'), 'export');
  });

  test('over-long names are truncated but keep their extension', () => {
    const long = `${'a'.repeat(300)}.docx`;
    const result = sanitiseFileName(long);
    assert.strictEqual(result.length, 120);
    assert.ok(result.endsWith('.docx'), result);
  });
});

suite('binaryExport — extension correction', () => {
  test('a matching extension is left alone', () => {
    assert.strictEqual(ensureExtension('report.docx', 'docx'), 'report.docx');
    assert.strictEqual(ensureExtension('report.DOCX', 'docx'), 'report.DOCX');
  });

  test('a known export extension is replaced', () => {
    assert.strictEqual(ensureExtension('report.txt', 'docx'), 'report.docx');
    assert.strictEqual(ensureExtension('report.png', 'xlsx'), 'report.xlsx');
  });

  test('an unknown extension is treated as part of the name', () => {
    assert.strictEqual(ensureExtension('report.final', 'docx'), 'report.final.docx');
    assert.strictEqual(ensureExtension('v0.7.5-notes', 'docx'), 'v0.7.5-notes.docx');
  });

  test('no extension requested means no change', () => {
    assert.strictEqual(ensureExtension('whatever', undefined), 'whatever');
  });
});

suite('binaryExport — default folder', () => {
  test('keeps a workspace-relative folder', () => {
    assert.strictEqual(normaliseDefaultDir('export/out'), 'export/out');
    assert.strictEqual(normaliseDefaultDir('export\\out'), 'export/out');
    assert.strictEqual(normaliseDefaultDir('./export/out/'), 'export/out');
  });

  test('absolute paths collapse to the workspace root', () => {
    assert.strictEqual(normaliseDefaultDir('C:/Windows/System32'), '');
    assert.strictEqual(normaliseDefaultDir('/etc'), '');
    assert.strictEqual(normaliseDefaultDir('\\\\server\\share'), '');
  });

  test('traversal collapses to the workspace root', () => {
    assert.strictEqual(normaliseDefaultDir('export/../../..'), '');
    assert.strictEqual(normaliseDefaultDir('..'), '');
  });

  test('an empty folder means the workspace root', () => {
    assert.strictEqual(normaliseDefaultDir(''), '');
    assert.strictEqual(normaliseDefaultDir(undefined), '');
  });
});

suite('binaryExport — dialog filters', () => {
  test('derives a labelled filter from the mime type', () => {
    const filters = buildSaveFilters({ content: ZIP4, mime: DOCX });
    assert.deepStrictEqual(filters, { 'Word document': ['docx'], 'All files': ['*'] });
  });

  test('falls back to the suggested name when the mime type is unknown', () => {
    const filters = buildSaveFilters({ content: ZIP4, mime: 'application/x-unknown', defaultName: 'a.b.csv' });
    assert.deepStrictEqual(filters, { 'CSV file': ['csv'], 'All files': ['*'] });
  });

  test('an unknown mime with no usable name offers All files only', () => {
    const filters = buildSaveFilters({ content: ZIP4, mime: 'application/x-unknown', defaultName: 'noext' });
    assert.deepStrictEqual(filters, { 'All files': ['*'] });
  });

  test('explicit filters win and are sanitised', () => {
    const filters = buildSaveFilters({
      content: ZIP4,
      mime: 'image/png',
      filters: { ' PNG image ': ['.PNG', 'png', '  '], '': ['xyz'], 'Bad ext': ['../etc'] },
    });
    assert.deepStrictEqual(filters, { 'PNG image': ['png'] });
  });

  test('an explicit "*" wildcard is preserved', () => {
    const filters = buildSaveFilters({ content: ZIP4, mime: 'image/png', filters: { 'All files': ['*'] } });
    assert.deepStrictEqual(filters, { 'All files': ['*'] });
  });

  test('the filter count is capped', () => {
    const many: Record<string, string[]> = {};
    for (let i = 0; i < MAX_FILTERS + 5; i += 1) {
      many[`Filter ${i}`] = [`e${i}`];
    }
    assert.strictEqual(Object.keys(buildSaveFilters({ content: ZIP4, mime: 'image/png', filters: many })).length, MAX_FILTERS);
  });
});

suite('binaryExport — size descriptions', () => {
  test('scales through the units', () => {
    assert.strictEqual(describeBytes(0), '0 B');
    assert.strictEqual(describeBytes(512), '512 B');
    assert.strictEqual(describeBytes(1024), '1.0 KB');
    assert.strictEqual(describeBytes(101310), '99 KB');
    assert.strictEqual(describeBytes(64 * 1024 * 1024), '64 MB');
  });

  test('nonsense input degrades instead of throwing', () => {
    assert.strictEqual(describeBytes(-1), '0 B');
    assert.strictEqual(describeBytes(Number.NaN), '0 B');
  });
});

suite('binaryExport — save planning', () => {
  test('resolves everything the dialog needs', () => {
    const result = planBinarySave({
      content: ZIP4,
      mime: XLSX,
      defaultName: 'register',
      defaultDir: 'export/out',
    });
    assert.strictEqual(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.strictEqual(result.plan.fileName, 'register.xlsx');
    assert.strictEqual(result.plan.defaultDir, 'export/out');
    assert.strictEqual(result.plan.bytes, 4);
    assert.strictEqual(result.plan.mime, XLSX);
    assert.deepStrictEqual(result.plan.filters, { 'Excel workbook': ['xlsx'], 'All files': ['*'] });
  });

  test('a missing suggestion still produces a safe, typed file name', () => {
    const result = planBinarySave({ content: ZIP4, mime: 'image/png' });
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(result.plan.fileName, 'export.png');
    }
  });

  test('a traversal defaultDir never survives planning', () => {
    const result = planBinarySave({ content: ZIP4, mime: 'image/png', defaultDir: '../../outside' });
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(result.plan.defaultDir, '');
    }
  });

  test('the plan carries the payload that was actually validated', () => {
    const result = planBinarySave({ content: 'data:image/png;base64,UEsD\nBA==', mime: 'image/png' });
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      // `Buffer.from(<data: URI>, 'base64')` decodes to garbage rather than
      // throwing, so the host must decode THIS value, never the raw request.
      assert.strictEqual(result.plan.payload, ZIP4);
      assert.deepStrictEqual(Buffer.from(result.plan.payload, 'base64'), Buffer.from(ZIP4, 'base64'));
    }
  });

  test('rejections carry the reason and a message', () => {
    const empty = planBinarySave({ content: '', mime: 'image/png' });
    assert.deepStrictEqual(empty.ok, false);
    if (!empty.ok) {
      assert.strictEqual(empty.reason, 'empty');
      assert.ok(empty.message.length > 0);
    }

    const invalid = planBinarySave({ content: '!!!', mime: 'image/png' });
    assert.strictEqual(invalid.ok, false);
    if (!invalid.ok) {
      assert.strictEqual(invalid.reason, 'not-base64');
    }

    const huge = planBinarySave({ content: ZIP4, mime: 'image/png' }, 1);
    assert.strictEqual(huge.ok, false);
    if (!huge.ok) {
      assert.strictEqual(huge.reason, 'too-large');
    }
  });
});
