import * as assert from 'assert';
import {
  BLOCKED_REASON_VALUES,
  DOC_STATUS_VALUES,
  DOCUMENT_COLUMNS,
  EVIDENCE_COLUMNS,
  ENVIRONMENT_VALUES,
  MEDIA_COLUMNS,
  RESULT_VALUES,
  RTM_COLUMNS,
  UTF8_BOM,
  csvHeader,
  csvRow,
  markdownTableHeader,
  toCsv,
  INPUT_COLUMNS,
  INPUT_STATUS_VALUES,
  INPUT_TYPE_VALUES,
} from '../../../shared/documentation/columns';

/** Every register in the project shares these guarantees. */
const REGISTERS = [
  RTM_COLUMNS,
  MEDIA_COLUMNS,
  EVIDENCE_COLUMNS,
  DOCUMENT_COLUMNS,
  INPUT_COLUMNS,
] as const;

/**
 * The registers exist in three forms (markdown table, csv, xlsx sheet) and they
 * MUST agree. These tests pin the agreement and the CSV surface.
 */
suite('documentation columns — contracts', () => {
  test('join keys keep fixed leading positions', () => {
    assert.deepStrictEqual(RTM_COLUMNS.slice(0, 2), ['REQ-ID', 'TITLE']);
    assert.deepStrictEqual(EVIDENCE_COLUMNS.slice(0, 2), ['EXEC-ID', 'TEST-CASE-ID']);
    assert.deepStrictEqual(EVIDENCE_COLUMNS.slice(0, 4), [
      'EXEC-ID',
      'TEST-CASE-ID',
      'REQ-ID',
      'CYCLE',
    ]);
    assert.deepStrictEqual(MEDIA_COLUMNS.slice(0, 2), ['MEDIA-ID', 'FILE']);
    assert.deepStrictEqual(DOCUMENT_COLUMNS.slice(0, 2), ['DOC-ID', 'TITLE']);
  });

  test('no duplicate column names within a register', () => {
    for (const columns of REGISTERS) {
      const unique = new Set(columns);
      assert.strictEqual(unique.size, columns.length, `duplicate in ${columns.join(',')}`);
    }
  });

  test('column names are uppercase ASCII with dashes only (Excel/CSV safe)', () => {
    for (const columns of REGISTERS) {
      for (const column of columns) {
        assert.match(column, /^[A-Z0-9-]+$/, `bad column name: ${column}`);
      }
    }
  });

  test('the evidence register carries the audit columns', () => {
    for (const required of [
      'CYCLE',
      'BUILD-VERSION',
      'ENVIRONMENT',
      'EXECUTED-UTC',
      'EXECUTED-BY',
      'WITNESSED-BY',
      'EXPECTED',
      'ACTUAL',
      'RESULT',
      'BLOCKED-REASON',
      'DEFECT-ID',
      'RETEST-OF',
      'EVIDENCE',
    ]) {
      assert.ok(
        (EVIDENCE_COLUMNS as readonly string[]).includes(required),
        `missing audit column ${required}`
      );
    }
  });

  test('media rows can prove the file was not altered after sign-off', () => {
    assert.ok((MEDIA_COLUMNS as readonly string[]).includes('HASH-SHA256'));
    assert.ok((MEDIA_COLUMNS as readonly string[]).includes('CAPTURED-UTC'));
  });

  test('fixed vocabularies are non-empty and unique', () => {
    for (const vocab of [
      RESULT_VALUES,
      ENVIRONMENT_VALUES,
      BLOCKED_REASON_VALUES,
      DOC_STATUS_VALUES,
    ]) {
      assert.ok(vocab.length >= 3);
      assert.strictEqual(new Set(vocab).size, vocab.length);
    }
    assert.ok((RESULT_VALUES as readonly string[]).includes('Pass'));
  });
});

suite('documentation columns — csv', () => {
  test('header is a plain comma join', () => {
    assert.strictEqual(csvHeader(RTM_COLUMNS), RTM_COLUMNS.join(','));
  });

  test('csv starts with a BOM and CRLF line endings', () => {
    const csv = toCsv(['A', 'B'], [['1', '2']]);
    assert.strictEqual(csv.charCodeAt(0), 0xfeff);
    assert.ok(csv.startsWith(UTF8_BOM + 'A,B\r\n'));
    assert.ok(csv.includes('1,2\r\n'));
  });

  test('BOM can be disabled', () => {
    const csv = toCsv(['A'], [['1']], { bom: false });
    assert.strictEqual(csv.charCodeAt(0), 'A'.charCodeAt(0));
  });

  test('cells containing separators are quoted, quotes doubled', () => {
    assert.strictEqual(csvRow(['a,b']), '"a,b"');
    assert.strictEqual(csvRow(['say "hi"']), '"say ""hi"""');
    assert.strictEqual(csvRow(['line1\nline2']), '"line1\nline2"');
  });

  test('leading and trailing spaces are preserved, not trimmed', () => {
    assert.strictEqual(csvRow([' padded ']), '" padded "');
  });

  test('undefined and null render as empty cells', () => {
    assert.strictEqual(csvRow([undefined, null, 'x']), ',,x');
  });

  test('short rows are padded so columns never shift', () => {
    assert.strictEqual(csvRow(['a'], 3), 'a,,');
  });

  test('long rows are truncated to the column count', () => {
    assert.strictEqual(csvRow(['a', 'b', 'c'], 2), 'a,b');
  });

  test('non-string values are stringified', () => {
    assert.strictEqual(csvRow([1, true]), '1,true');
  });
});

suite('documentation columns — markdown parity', () => {
  test('the markdown header uses exactly the csv column names', () => {
    for (const columns of [RTM_COLUMNS, MEDIA_COLUMNS, EVIDENCE_COLUMNS]) {
      const [header, separator] = markdownTableHeader(columns);
      const cells = header
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim());
      assert.deepStrictEqual(cells, [...columns], 'markdown header drifted from csv');
      assert.strictEqual(separator.split('|').length, header.split('|').length);
    }
  });
  test('input vocabularies are fixed and unique', () => {
    for (const vocab of [INPUT_TYPE_VALUES, INPUT_STATUS_VALUES]) {
      assert.ok(vocab.length >= 3);
      assert.strictEqual(new Set(vocab).size, vocab.length);
    }
    assert.ok((INPUT_STATUS_VALUES as readonly string[]).includes('Incorporated'));
  });

  test('the input register closes the provenance chain', () => {
    for (const required of [
      'INPUT-ID',
      'TYPE',
      'FILE',
      'LINKED-DOC',
      'LINKED-REQ',
      'STATUS',
      'CLASSIFICATION',
      'HASH-SHA256',
    ]) {
      assert.ok(
        (INPUT_COLUMNS as readonly string[]).includes(required),
        `missing provenance column ${required}`
      );
    }
    assert.strictEqual(INPUT_COLUMNS[0], 'INPUT-ID', 'the id column must stay first');
  });
});
