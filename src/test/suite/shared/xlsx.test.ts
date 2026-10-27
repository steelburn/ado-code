import * as assert from 'assert';
import { mdToDocBlocks } from '../../../shared/docBlocks';
import {
  STYLE_BODY,
  STYLE_DATE,
  STYLE_DATETIME,
  STYLE_HEADER,
  STYLE_LINK,
  XLSX_MAX_SHEET_NAME,
  bytesToBase64,
  buildWorkbookParts,
  columnIndex,
  columnLetter,
  dateToSerial,
  escapeXml,
  infoSheet,
  parseIsoDateText,
  serializeXlsx,
  sheetFromTable,
  stripInvalidXmlChars,
  utf8Encode,
  type XlsxSheet,
  type XlsxWorkbook,
} from '../../../shared/xlsx';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parts(workbook: XlsxWorkbook): Record<string, string> {
  return buildWorkbookParts(workbook).files;
}

function sheetXml(workbook: XlsxWorkbook, index = 0): string {
  return parts(workbook)[`xl/worksheets/sheet${index + 1}.xml`] ?? '';
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function sheet(overrides: Partial<XlsxSheet> = {}): XlsxSheet {
  return {
    name: 'Registers',
    columns: [{ header: 'REQ-ID', type: 'text' }],
    rows: [['REQ-001']],
    ...overrides,
  };
}

function simpleWorkbook(overrides: Partial<XlsxWorkbook> = {}): XlsxWorkbook {
  return { title: 'Test', sheets: [sheet()], ...overrides };
}

const TIMESTAMP = new Date('2024-01-15T00:00:00Z');

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

suite('xlsx — primitives', () => {
  test('columnLetter walks past Z into two and three letters', () => {
    assert.strictEqual(columnLetter(1), 'A');
    assert.strictEqual(columnLetter(26), 'Z');
    assert.strictEqual(columnLetter(27), 'AA');
    assert.strictEqual(columnLetter(52), 'AZ');
    assert.strictEqual(columnLetter(53), 'BA');
    assert.strictEqual(columnLetter(702), 'ZZ');
    assert.strictEqual(columnLetter(703), 'AAA');
    assert.strictEqual(columnLetter(16384), 'XFD');
  });

  test('columnLetter degrades instead of producing invalid refs', () => {
    assert.strictEqual(columnLetter(0), 'A');
    assert.strictEqual(columnLetter(-5), 'A');
    assert.strictEqual(columnLetter(Number.NaN), 'A');
  });

  test('columnIndex is the inverse of columnLetter', () => {
    for (const index of [1, 26, 27, 53, 703, 16384]) {
      assert.strictEqual(columnIndex(columnLetter(index)), index);
    }
  });

  test('escapeXml handles the five XML metacharacters', () => {
    assert.strictEqual(
      escapeXml(`A & B < C > D "q" 'x'`),
      'A &amp; B &lt; C &gt; D &quot;q&quot; &apos;x&apos;',
    );
  });

  test('stripInvalidXmlChars removes characters Excel rejects', () => {
    assert.strictEqual(stripInvalidXmlChars('a\u0000b\u0001c\u000Bd\u001Fe'), 'abcde');
    // Tab, LF and CR are legal XML and must survive.
    assert.strictEqual(stripInvalidXmlChars('a\tb\nc\rd'), 'a\tb\nc\rd');
  });

  test('stripInvalidXmlChars drops lone surrogates but keeps pairs', () => {
    assert.strictEqual(stripInvalidXmlChars('a\uD800b'), 'ab');
    assert.strictEqual(stripInvalidXmlChars('a\uD83D\uDE00b'), 'a\uD83D\uDE00b');
  });

  test('utf8Encode produces real UTF-8 for ASCII, two-, three- and four-byte points', () => {
    assert.deepStrictEqual(Array.from(utf8Encode('A')), [0x41]);
    assert.deepStrictEqual(Array.from(utf8Encode('é')), [0xc3, 0xa9]);
    assert.deepStrictEqual(Array.from(utf8Encode('中')), [0xe4, 0xb8, 0xad]);
    assert.deepStrictEqual(Array.from(utf8Encode('😀')), [0xf0, 0x9f, 0x98, 0x80]);
  });

  test('bytesToBase64 matches the ZIP magic of a real archive', () => {
    assert.strictEqual(bytesToBase64(utf8Encode('PK\u0003\u0004')), 'UEsDBA==');
    assert.strictEqual(bytesToBase64(new Uint8Array(0)), '');
  });

  test('bytesToBase64 handles lengths that need padding', () => {
    assert.strictEqual(bytesToBase64(new Uint8Array([0x61])), 'YQ==');
    assert.strictEqual(bytesToBase64(new Uint8Array([0x61, 0x62])), 'YWI=');
    assert.strictEqual(bytesToBase64(new Uint8Array([0x61, 0x62, 0x63])), 'YWJj');
  });

  test('dateToSerial converts to the Excel epoch', () => {
    assert.strictEqual(dateToSerial(new Date('2024-01-15T00:00:00Z')).serial, 45306);
    assert.strictEqual(dateToSerial(new Date('1900-03-01T00:00:00Z')).serial, 61);
    assert.strictEqual(dateToSerial(new Date('2024-01-15T00:00:00Z')).hasTime, false);
  });

  test('dateToSerial keeps the time of day as a fraction', () => {
    const result = dateToSerial(new Date('2024-01-15T13:30:00Z'));
    assert.strictEqual(result.hasTime, true);
    assert.strictEqual(result.serial, 45306.5625);
  });

  test('dateToSerial degrades on an invalid Date instead of throwing', () => {
    assert.deepStrictEqual(dateToSerial(new Date('nonsense')), { serial: 0, hasTime: false });
  });

  test('parseIsoDateText accepts date-only and full instants, rejects prose', () => {
    assert.strictEqual(parseIsoDateText('2024-01-15')?.toISOString(), '2024-01-15T00:00:00.000Z');
    assert.strictEqual(parseIsoDateText('2024/01/15')?.toISOString(), '2024-01-15T00:00:00.000Z');
    assert.strictEqual(
      parseIsoDateText('2024-01-15T09:05:00Z')?.toISOString(),
      '2024-01-15T09:05:00.000Z',
    );
    assert.strictEqual(parseIsoDateText('15 Jan 2024'), null);
    assert.strictEqual(parseIsoDateText('   '), null);
  });
});

// ---------------------------------------------------------------------------
// Part inventory
// ---------------------------------------------------------------------------

suite('xlsx — workbook parts', () => {
  test('emits every part a spreadsheet reader requires', () => {
    const files = parts(simpleWorkbook());
    for (const path of [
      '[Content_Types].xml',
      '_rels/.rels',
      'docProps/core.xml',
      'docProps/app.xml',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/sharedStrings.xml',
      'xl/worksheets/sheet1.xml',
    ]) {
      assert.ok(files[path], `missing part ${path}`);
    }
  });

  test('every part is a standalone XML document', () => {
    for (const [path, xml] of Object.entries(parts(simpleWorkbook()))) {
      assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'), path);
      assert.ok(xml.trimEnd().endsWith('>'), path);
    }
  });

  test('content types declare each sheet and the two shared parts', () => {
    const xml = parts(simpleWorkbook({ sheets: [sheet(), { ...sheet(), name: 'Second' }] }))[
      '[Content_Types].xml'
    ];
    assert.strictEqual(count(xml, 'spreadsheetml.worksheet+xml'), 2);
    assert.ok(xml.includes('/xl/worksheets/sheet1.xml'));
    assert.ok(xml.includes('/xl/worksheets/sheet2.xml'));
    assert.ok(xml.includes('spreadsheetml.styles+xml'));
    assert.ok(xml.includes('spreadsheetml.sharedStrings+xml'));
    assert.ok(xml.includes('Extension="rels"'));
  });

  test('workbook lists sheets and its relationships point at them', () => {
    const files = parts(simpleWorkbook({ sheets: [sheet(), { ...sheet(), name: 'Second' }] }));
    assert.ok(files['xl/workbook.xml'].includes('<sheet name="Registers" sheetId="1" r:id="rId1"/>'));
    assert.ok(files['xl/workbook.xml'].includes('<sheet name="Second" sheetId="2" r:id="rId2"/>'));
  });

  test('workbook relationships resolve to worksheet, styles and shared strings targets', () => {
    const rels = parts(simpleWorkbook())[ 'xl/_rels/workbook.xml.rels'];
    assert.ok(rels.includes('Target="worksheets/sheet1.xml"'));
    assert.ok(rels.includes('Target="styles.xml"'));
    assert.ok(rels.includes('Target="sharedStrings.xml"'));
    // Sheet rels come first, so styles/sharedStrings must not collide with them.
    assert.ok(rels.includes('Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"'));
  });

  test('styles.xml declares both custom date formats and every cellXf we reference', () => {
    const styles = parts(simpleWorkbook())['xl/styles.xml'];
    assert.ok(styles.includes('formatCode="yyyy-mm-dd hh:mm"'));
    assert.ok(styles.includes('formatCode="yyyy-mm-dd"'));
    assert.ok(styles.includes('<cellXfs count="6">'));
    assert.ok(styles.includes('<numFmts count="2">'));
  });

  test('an empty workbook still produces a valid archive, with a warning', () => {
    const result = buildWorkbookParts({ sheets: [] });
    assert.deepStrictEqual(result.sheetNames, ['Sheet1']);
    assert.ok(result.files['xl/worksheets/sheet1.xml']);
    assert.strictEqual(result.warnings[0].code, 'empty-workbook');
  });

  test('core properties carry the workbook title and creator', () => {
    const core = parts(simpleWorkbook({ creator: 'PTM Test Team' }))['docProps/core.xml'];
    assert.ok(core.includes('<dc:title>Test</dc:title>'));
    assert.ok(core.includes('<dc:creator>PTM Test Team</dc:creator>'));
  });

  test('core properties use a stable W3CDTF timestamp without milliseconds', () => {
    const core = parts(simpleWorkbook({ generatedAt: TIMESTAMP }))['docProps/core.xml'];
    assert.ok(core.includes('2024-01-15T00:00:00Z'));
    assert.ok(!core.includes('.000Z'));
  });
});

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

suite('xlsx — cells', () => {
  test('header row uses the header style and spans the column count', () => {
    const xml = sheetXml(
      simpleWorkbook({
        sheets: [sheet({ columns: [{ header: 'REQ-ID' }, { header: 'TITLE' }], rows: [] })],
      }),
    );
    assert.ok(xml.includes('<row r="1" spans="1:2">'));
    assert.ok(xml.includes(`r="A1" s="${STYLE_HEADER}" t="s"`));
    assert.ok(xml.includes(`r="B1" s="${STYLE_HEADER}" t="s"`));
  });

  test('text cells reference the shared string table and carry the body style', () => {
    const files = parts(simpleWorkbook());
    assert.ok(files['xl/worksheets/sheet1.xml'].includes(`r="A2" s="${STYLE_BODY}" t="s"`));
    assert.ok(files['xl/sharedStrings.xml'].includes('<si><t>REQ-001</t></si>'));
  });

  test('shared strings dedupe repeated values and keep both counts', () => {
    const files = parts(
      simpleWorkbook({
        sheets: [
          sheet({
            columns: [{ header: 'ENV' }, { header: 'RESULT' }],
            rows: [
              ['UAT', 'Pass'],
              ['UAT', 'Pass'],
              ['UAT', 'Fail'],
            ],
          }),
        ],
      }),
    );
    const sst = files['xl/sharedStrings.xml'];
    // header(2) + 3 rows * 2 cells = 8 references, 5 distinct values.
    assert.ok(sst.includes('count="8"'), sst.slice(0, 200));
    assert.ok(sst.includes('uniqueCount="5"'));
    assert.strictEqual(count(sst, '<si><t>UAT</t></si>'), 1);
  });

  test('preserves leading and trailing spaces via xml:space', () => {
    const sst = parts(
      simpleWorkbook({ sheets: [sheet({ rows: [[' padded ']] })] }),
    )['xl/sharedStrings.xml'];
    assert.ok(sst.includes('<si><t xml:space="preserve"> padded </t></si>'));
  });

  test('numbers are written as numeric cells, never as text', () => {
    const xml = sheetXml(
      simpleWorkbook({
        sheets: [sheet({ columns: [{ header: 'COUNT', type: 'number' }], rows: [[42], ['1,250']] })],
      }),
    );
    assert.ok(xml.includes('<c r="A2" s="2"><v>42</v></c>'));
    assert.ok(xml.includes('<c r="A3" s="2"><v>1250</v></c>'));
  });

  test('booleans become t="b" cells with 1/0', () => {
    const xml = sheetXml(
      simpleWorkbook({
        sheets: [sheet({ columns: [{ header: 'DONE', type: 'boolean' }], rows: [[true], [false]] })],
      }),
    );
    assert.ok(xml.includes('t="b"><v>1</v>'));
    assert.ok(xml.includes('t="b"><v>0</v>'));
  });

  test('dates become serials with the date number format, datetimes with the datetime one', () => {
    const xml = sheetXml(
      simpleWorkbook({
        sheets: [
          sheet({
            columns: [
              { header: 'DAY', type: 'date' },
              { header: 'AT', type: 'datetime' },
            ],
            rows: [[new Date('2024-01-15'), new Date('2024-01-15T13:30:00Z')]],
          }),
        ],
      }),
    );
    assert.ok(xml.includes(`r="A2" s="${STYLE_DATE}"><v>45306</v>`));
    assert.ok(xml.includes(`r="B2" s="${STYLE_DATETIME}"><v>45306.5625</v>`));
  });

  test('ISO date text in a date column is coerced to a real date cell', () => {
    const xml = sheetXml(
      simpleWorkbook({
        sheets: [sheet({ columns: [{ header: 'EXECUTED-UTC', type: 'date' }], rows: [['2024-02-01']] })],
      }),
    );
    assert.ok(xml.includes(`s="${STYLE_DATE}"><v>45323</v>`));
  });

  test('a date-only value in a datetime column keeps the date format', () => {
    // The value decides the number format: forcing the datetime format would
    // display "2024-02-01 00:00", which reads as a recorded time when none was.
    const xml = sheetXml(
      simpleWorkbook({
        sheets: [
          sheet({
            columns: [{ header: 'EXECUTED-UTC', type: 'datetime' }],
            rows: [['2024-02-01'], [new Date('2024-02-01T10:15:00Z')]],
          }),
        ],
      }),
    );
    assert.ok(xml.includes(`r="A2" s="${STYLE_DATE}"><v>45323</v>`));
    assert.ok(xml.includes(`r="A3" s="${STYLE_DATETIME}">`));
  });

  test('an unparseable date stays as text and says so', () => {
    const result = buildWorkbookParts(
      simpleWorkbook({
        sheets: [sheet({ columns: [{ header: 'EXECUTED-UTC', type: 'date' }], rows: [['last tuesday']] })],
      }),
    );
    assert.ok(result.files['xl/sharedStrings.xml'].includes('last tuesday'));
    assert.ok(result.warnings.some((warning) => warning.code === 'invalid-date'));
  });

  test('text that looks like a formula is never emitted as one', () => {
    const result = buildWorkbookParts(
      simpleWorkbook({ sheets: [sheet({ rows: [['=SUM(A1:A2)'], ['+44 1234'], ['-dash']] })] }),
    );
    const xml = result.files['xl/worksheets/sheet1.xml'];
    const sst = result.files['xl/sharedStrings.xml'];
    assert.ok(sst.includes('=SUM(A1:A2)'));
    assert.ok(xml.includes('t="s"'));
    // The whole workbook must be formula-free: every value is a cached literal.
    for (const part of Object.values(result.files)) {
      assert.strictEqual(part.includes('<f>'), false);
      assert.strictEqual(part.includes('<f '), false);
    }
  });

  test('no part of a rich workbook contains a formula element', () => {
    const result = buildWorkbookParts({
      sheets: [
        sheet({
          columns: [
            { header: 'TC', type: 'text' },
            { header: 'COUNT', type: 'number' },
            { header: 'DAY', type: 'date' },
            { header: 'RESULT', type: 'enum', values: ['Pass', 'Fail'] },
          ],
          rows: [['TC-001', 3, new Date('2024-01-15'), 'Pass']],
        }),
      ],
    });
    for (const [path, part] of Object.entries(result.files)) {
      assert.ok(!/<f[\s>]/.test(part), `${path} contains a formula`);
      // A `<v>` without `<f>` is exactly the shape a viewer can render cold.
      if (path.startsWith('xl/worksheets/')) {
        assert.ok(part.includes('<v>'));
      }
    }
  });

  test('control characters are stripped so Excel does not offer to repair', () => {
    const result = buildWorkbookParts(
      simpleWorkbook({ sheets: [sheet({ rows: [['ok\u0001value']] })] }),
    );
    assert.ok(result.files['xl/sharedStrings.xml'].includes('<t>okvalue</t>'));
  });

  test('an over-long cell is truncated and reported', () => {
    const result = buildWorkbookParts(
      simpleWorkbook({ sheets: [sheet({ rows: [['x'.repeat(40_000)]] })] }),
    );
    const warning = result.warnings.find((entry) => entry.code === 'cell-truncated');
    assert.ok(warning, 'expected a cell-truncated warning');
    assert.ok(result.files['xl/sharedStrings.xml'].includes('x'.repeat(32_767)));
  });

  test('non-finite numbers are dropped with a warning rather than corrupting the file', () => {
    const result = buildWorkbookParts(
      simpleWorkbook({
        sheets: [sheet({ columns: [{ header: 'N', type: 'number' }], rows: [[Number.POSITIVE_INFINITY]] })],
      }),
    );
    assert.ok(result.warnings.some((warning) => warning.code === 'invalid-number'));
    assert.ok(result.files['xl/worksheets/sheet1.xml'].includes('<row r="2" spans="1:1"></row>'));
  });

  test('null and undefined leave the cell out without shifting its neighbours', () => {
    const xml = sheetXml(
      simpleWorkbook({
        sheets: [
          sheet({
            columns: [{ header: 'A' }, { header: 'B' }, { header: 'C' }],
            rows: [[null, 'middle', undefined]],
          }),
        ],
      }),
    );
    assert.ok(!xml.includes('r="A2"'));
    assert.ok(xml.includes('r="B2"'));
    assert.ok(!xml.includes('r="C2"'));
  });

  test('cells past Z get correct absolute references', () => {
    const columns = Array.from({ length: 28 }, (_entry, index) => ({ header: `C${index + 1}` }));
    const rows = [Array.from({ length: 28 }, (_entry, index) => `v${index + 1}`)];
    const xml = sheetXml(simpleWorkbook({ sheets: [sheet({ columns, rows })] }));
    assert.ok(xml.includes('r="AA1"'));
    assert.ok(xml.includes('r="AB2"'));
    assert.ok(xml.includes('<dimension ref="A1:AB2"/>'));
  });
});

// ---------------------------------------------------------------------------
// Sheet features
// ---------------------------------------------------------------------------

suite('xlsx — sheet features', () => {
  test('freezes the header row by default', () => {
    const xml = sheetXml(simpleWorkbook());
    assert.ok(xml.includes('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'));
    assert.ok(xml.includes('tabSelected="1"'));
  });

  test('freezeHeader false leaves the sheet unfrozen', () => {
    const xml = sheetXml(simpleWorkbook({ sheets: [sheet({ freezeHeader: false })] }));
    assert.ok(!xml.includes('<pane '));
  });

  test('adds an auto filter over the used range', () => {
    const xml = sheetXml(
      simpleWorkbook({
        sheets: [
          sheet({
            columns: [{ header: 'A' }, { header: 'B' }],
            rows: [
              ['1', '2'],
              ['3', '4'],
            ],
          }),
        ],
      }),
    );
    assert.ok(xml.includes('<autoFilter ref="A1:B3"/>'));
  });

  test('a single-column sheet has no auto filter by default', () => {
    assert.ok(!sheetXml(simpleWorkbook()).includes('<autoFilter'));
  });

  test('column widths are emitted per column with customWidth', () => {
    const xml = sheetXml(
      simpleWorkbook({
        sheets: [sheet({ columns: [{ header: 'A', width: 40 }, { header: 'B' }], rows: [] })],
      }),
    );
    assert.ok(xml.includes('<col min="1" max="1" width="40" customWidth="1"/>'));
    assert.ok(xml.includes('<col min="2" max="2" width="24" customWidth="1"/>'));
  });

  test('element order follows the schema (autoFilter before dataValidations before hyperlinks)', () => {
    const xml = sheetXml(
      simpleWorkbook({
        sheets: [
          sheet({
            columns: [
              { header: 'RESULT', type: 'enum', values: ['Pass', 'Fail'] },
              { header: 'EVIDENCE' },
            ],
            rows: [['Pass', { text: 'EVD-001.png', href: '../../assets/evidence/EVD-001.png' }]],
          }),
        ],
      }),
    );
    const filter = xml.indexOf('<autoFilter');
    const validations = xml.indexOf('<dataValidations');
    const hyperlinks = xml.indexOf('<hyperlinks');
    assert.ok(filter > 0 && validations > filter, 'autoFilter must precede dataValidations');
    assert.ok(hyperlinks > validations, 'hyperlinks must follow dataValidations');
  });

  test('an empty sheet is reported but still written', () => {
    const result = buildWorkbookParts(simpleWorkbook({ sheets: [sheet({ rows: [] })] }));
    assert.ok(result.warnings.some((warning) => warning.code === 'empty-sheet'));
    assert.ok(result.files['xl/worksheets/sheet1.xml'].includes('<row r="1"'));
  });
});

// ---------------------------------------------------------------------------
// Data validation
// ---------------------------------------------------------------------------

suite('xlsx — data validation', () => {
  const enumSheet = (extraRows?: number): XlsxSheet =>
    sheet({
      columns: [
        { header: 'RESULT', type: 'enum', values: ['Pass', 'Fail', 'Blocked', 'Not Run'] },
        { header: 'NOTES' },
      ],
      rows: [['Pass', 'a'], ['Fail', 'b'], ['Pass', 'c']],
      validationExtraRows: extraRows,
    });

  test('an enum column produces a list dropdown with a quoted vocabulary', () => {
    const xml = sheetXml(simpleWorkbook({ sheets: [enumSheet(0)] }));
    assert.ok(xml.includes('<dataValidations count="1">'));
    assert.ok(xml.includes('type="list"'));
    assert.ok(xml.includes('<formula1>"Pass,Fail,Blocked,Not Run"</formula1>'));
    assert.ok(xml.includes('allowBlank="1"'));
  });

  test('the dropdown covers the data rows plus the growth allowance', () => {
    const xml = sheetXml(simpleWorkbook({ sheets: [enumSheet(0)] }));
    assert.ok(xml.includes('sqref="A2:A4"'));
  });

  test('the default growth allowance extends the dropdown past the last row', () => {
    const xml = sheetXml(simpleWorkbook({ sheets: [enumSheet()] }));
    assert.ok(xml.includes('sqref="A2:A204"'));
  });

  test('a vocabulary longer than 255 characters is dropped with a warning', () => {
    const values = Array.from({ length: 40 }, (_entry, index) => `Value-${index}-${'x'.repeat(5)}`);
    const result = buildWorkbookParts(
      simpleWorkbook({ sheets: [sheet({ columns: [{ header: 'LONG', type: 'enum', values }], rows: [] })] }),
    );
    assert.ok(!result.files['xl/worksheets/sheet1.xml'].includes('<dataValidations'));
    assert.ok(result.warnings.some((warning) => warning.code === 'validation-too-long'));
  });

  test('a value containing a comma is dropped with a warning, not silently split', () => {
    const result = buildWorkbookParts(
      simpleWorkbook({
        sheets: [sheet({ columns: [{ header: 'BROKEN', type: 'enum', values: ['a,b', 'c'] }], rows: [] })],
      }),
    );
    assert.ok(!result.files['xl/worksheets/sheet1.xml'].includes('<dataValidations'));
    assert.ok(result.warnings.some((warning) => warning.code === 'validation-unsupported-chars'));
  });

  test('only enumerated columns get validations', () => {
    const xml = sheetXml(simpleWorkbook({ sheets: [enumSheet(0)] }));
    assert.strictEqual(count(xml, '<dataValidation '), 1);
  });

  test('two enumerated columns produce two validations and a matching count', () => {
    const xml = sheetXml(
      simpleWorkbook({
        sheets: [
          sheet({
            columns: [
              { header: 'ENV', type: 'enum', values: ['SIT', 'UAT'] },
              { header: 'RESULT', type: 'enum', values: ['Pass', 'Fail'] },
            ],
            rows: [['SIT', 'Pass']],
          }),
        ],
      }),
    );
    assert.ok(xml.includes('<dataValidations count="2">'));
    assert.strictEqual(count(xml, '<dataValidation '), 2);
  });
});

// ---------------------------------------------------------------------------
// Hyperlinks
// ---------------------------------------------------------------------------

suite('xlsx — hyperlinks', () => {
  const linkWorkbook = (): XlsxWorkbook =>
    simpleWorkbook({
      sheets: [
        sheet({
          columns: [{ header: 'EVIDENCE' }, { header: 'NOTES' }],
          rows: [[{ text: 'EVD-001.png', href: '../../assets/evidence/EVD-001.png' }, 'ok']],
        }),
      ],
    });

  test('a link cell writes the relationship part with an external target', () => {
    const files = parts(linkWorkbook());
    const rels = files['xl/worksheets/_rels/sheet1.xml.rels'];
    assert.ok(rels, 'expected a sheet relationship part');
    assert.ok(rels.includes('Target="../../assets/evidence/EVD-001.png"'));
    assert.ok(rels.includes('TargetMode="External"'));
    assert.ok(rels.includes('relationships/hyperlink'));
  });

  test('the sheet references the hyperlink by relationship id', () => {
    const xml = sheetXml(linkWorkbook());
    assert.ok(xml.includes('<hyperlinks><hyperlink ref="A2" r:id="rId1"/></hyperlinks>'));
  });

  test('the link cell keeps its text in the shared string table and uses the link style', () => {
    const files = parts(linkWorkbook());
    assert.ok(files['xl/sharedStrings.xml'].includes('<si><t>EVD-001.png</t></si>'));
    assert.ok(files['xl/worksheets/sheet1.xml'].includes(`r="A2" s="${STYLE_LINK}" t="s"`));
  });

  test('a link without a target stays plain text and creates no relationship', () => {
    const files = parts(
      simpleWorkbook({ sheets: [sheet({ rows: [[{ text: 'EVD-002.png' }]] })] }),
    );
    assert.strictEqual(files['xl/worksheets/_rels/sheet1.xml.rels'], undefined);
    assert.ok(!files['xl/worksheets/sheet1.xml'].includes('<hyperlinks'));
  });

  test('multiple links get sequential relationship ids', () => {
    const files = parts(
      simpleWorkbook({
        sheets: [
          sheet({
            columns: [{ header: 'EVIDENCE' }],
            rows: [
              [{ text: 'a.png', href: 'a.png' }],
              [{ text: 'b.png', href: 'b.png' }],
            ],
          }),
        ],
      }),
    );
    const rels = files['xl/worksheets/_rels/sheet1.xml.rels'];
    assert.ok(rels.includes('Id="rId1"'));
    assert.ok(rels.includes('Id="rId2"'));
    assert.ok(files['xl/worksheets/sheet1.xml'].includes('<hyperlink ref="A3" r:id="rId2"/>'));
  });
});

// ---------------------------------------------------------------------------
// Sheet-name hygiene
// ---------------------------------------------------------------------------

suite('xlsx — sheet names', () => {
  test('illegal characters are replaced and reported', () => {
    const result = buildWorkbookParts(simpleWorkbook({ sheets: [sheet({ name: 'A/B:C*D?E[F]G' })] }));
    assert.deepStrictEqual(result.sheetNames, ['A-B-C-D-E-F-G']);
    assert.ok(result.warnings.some((warning) => warning.code === 'sheet-name-fixed'));
  });

  test('names longer than 31 characters are truncated', () => {
    const long = 'Traceability Matrix For All Requirements';
    const result = buildWorkbookParts(simpleWorkbook({ sheets: [sheet({ name: long })] }));
    assert.strictEqual(result.sheetNames[0].length, XLSX_MAX_SHEET_NAME);
    assert.ok(result.warnings.some((warning) => warning.code === 'sheet-name-fixed'));
  });

  test('duplicate names are de-duplicated case-insensitively', () => {
    const result = buildWorkbookParts(
      simpleWorkbook({ sheets: [sheet({ name: 'RTM' }), sheet({ name: 'rtm' }), sheet({ name: 'RTM' })] }),
    );
    assert.deepStrictEqual(result.sheetNames, ['RTM', 'rtm (2)', 'RTM (3)']);
    assert.ok(result.warnings.some((warning) => warning.code === 'sheet-name-deduped'));
  });

  test('de-duplication keeps the result inside the 31-character limit', () => {
    const name = 'x'.repeat(31);
    const result = buildWorkbookParts(simpleWorkbook({ sheets: [sheet({ name }), sheet({ name })] }));
    for (const written of result.sheetNames) {
      assert.ok(written.length <= XLSX_MAX_SHEET_NAME, `${written} is too long`);
    }
  });

  test('an empty name becomes "Sheet"', () => {
    const result = buildWorkbookParts(simpleWorkbook({ sheets: [sheet({ name: '   ' })] }));
    assert.strictEqual(result.sheetNames[0], 'Sheet');
  });

  test('sheet names are XML-escaped in the workbook part', () => {
    const files = parts(simpleWorkbook({ sheets: [sheet({ name: 'R&D' })] }));
    assert.ok(files['xl/workbook.xml'].includes('name="R&amp;D"'));
  });
});

// ---------------------------------------------------------------------------
// Overflow guards
// ---------------------------------------------------------------------------

suite('xlsx — limits', () => {
  test('more columns than Excel supports are dropped with a warning', () => {
    const columns = Array.from({ length: 16_385 }, (_entry, index) => ({ header: `C${index}` }));
    const result = buildWorkbookParts(simpleWorkbook({ sheets: [sheet({ columns, rows: [] })] }));
    assert.ok(result.warnings.some((warning) => warning.code === 'column-overflow'));
    // 16385 columns would be beyond XFD; the written dimension must stay legal.
    assert.ok(result.files['xl/worksheets/sheet1.xml'].includes('<dimension ref="A1:XFD1"/>'));
  });
});

// ---------------------------------------------------------------------------
// Archive assembly
// ---------------------------------------------------------------------------

suite('xlsx — serializeXlsx', () => {
  test('hands UTF-8 bytes to the injected ZIP function, in part order', () => {
    const seen: Record<string, Uint8Array> = {};
    let order: string[] = [];
    const result = serializeXlsx(simpleWorkbook(), (files) => {
      order = Object.keys(files);
      Object.assign(seen, files);
      return new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    });

    assert.deepStrictEqual(Array.from(result.bytes), [0x50, 0x4b, 0x03, 0x04]);
    assert.strictEqual(order[0], '[Content_Types].xml');
    assert.ok(seen['xl/worksheets/sheet1.xml'] instanceof Uint8Array);
    // Real UTF-8, not UTF-16 or latin1.
    assert.deepStrictEqual(
      Array.from(seen['[Content_Types].xml'].subarray(0, 5)),
      Array.from(utf8Encode('<?xml')),
    );
  });

  test('returns the warnings and final sheet names alongside the bytes', () => {
    const result = serializeXlsx(
      { sheets: [sheet({ name: 'A/B' })] },
      () => new Uint8Array([1, 2, 3]),
    );
    assert.deepStrictEqual(result.sheetNames, ['A-B']);
    assert.ok(result.warnings.some((warning) => warning.code === 'sheet-name-fixed'));
    assert.strictEqual(bytesToBase64(result.bytes), 'AQID');
  });

  test('every part survives a UTF-8 round-trip through the encoder', () => {
    const files = parts(simpleWorkbook({ sheets: [sheet({ rows: [['Akses — TERHAD']] })] }));
    const bytes = utf8Encode(files['xl/sharedStrings.xml']);
    assert.ok(bytes.length > 0);
    // Round-trip through our own decoder-free path: the marker bytes must be UTF-8.
    const source = files['xl/sharedStrings.xml'];
    assert.ok(source.includes('Akses'));
    assert.ok(source.includes('\u2014'));
  });
});

// ---------------------------------------------------------------------------
// Model helpers
// ---------------------------------------------------------------------------

suite('xlsx — infoSheet', () => {
  test('renders label/value provenance rows with the workbook timestamp', () => {
    const info = infoSheet({
      title: 'RTM',
      generatedAt: TIMESTAMP,
      fields: [['Project', 'MyGov'], ['Role', 'Tester']],
      notes: ['Regenerate with: node export/export-xlsx.js'],
    });
    assert.strictEqual(info.name, 'Info');
    assert.deepStrictEqual(info.rows[0], ['Workbook', 'RTM']);
    assert.deepStrictEqual(info.rows[1], ['Project', 'MyGov']);
    assert.deepStrictEqual(info.rows[2], ['Role', 'Tester']);
    assert.deepStrictEqual(info.rows[3], ['Generated at (UTC)', TIMESTAMP]);
    assert.strictEqual(info.autoFilter, false);
  });

  test('the info sheet keeps its values as text so nothing is reinterpreted', () => {
    const info = infoSheet({ fields: [['Version', '1.20']] });
    assert.deepStrictEqual(info.columns.map((column) => column.type), ['text', 'text']);
  });
});

suite('xlsx — sheetFromTable', () => {
  const tableDoc = [
    '| REQ-ID | TITLE | PRIORITY | EXECUTED |',
    '| --- | --- | --- | --- |',
    '| **REQ-001** | Login | 1 | 2024-01-15 |',
    '| REQ-002 | Logout | 2 | 2024-01-16 |',
  ].join('\n');

  function firstTable(): Extract<ReturnType<typeof mdToDocBlocks>['blocks'][number], { kind: 'table' }> {
    const parsed = mdToDocBlocks(tableDoc);
    const block = parsed.blocks.find((entry) => entry.kind === 'table');
    assert.ok(block && block.kind === 'table', 'fixture must contain a table');
    return block;
  }

  test('flattens inline Markdown through the shared parser', () => {
    const built = sheetFromTable(firstTable(), { name: 'Requirements' });
    assert.strictEqual(built.rows[0][0], 'REQ-001');
    assert.deepStrictEqual(built.columns.map((column) => column.header), [
      'REQ-ID',
      'TITLE',
      'PRIORITY',
      'EXECUTED',
    ]);
  });

  test('infers numeric and date columns and leaves IDs as text', () => {
    const built = sheetFromTable(firstTable(), { name: 'Requirements' });
    assert.deepStrictEqual(built.columns.map((column) => column.type), ['text', 'text', 'number', 'date']);
  });

  test('parsed dates arrive as Date instances so they serialise as date cells', () => {
    const built = sheetFromTable(firstTable(), { name: 'Requirements' });
    assert.ok(built.rows[0][3] instanceof Date);
    assert.strictEqual((built.rows[0][3] as Date).toISOString(), '2024-01-15T00:00:00.000Z');
  });

  test('enum overrides attach the vocabulary and win over inference', () => {
    const built = sheetFromTable(firstTable(), {
      name: 'Requirements',
      enumColumns: { PRIORITY: ['1', '2', '3'] },
    });
    assert.strictEqual(built.columns[2].type, 'enum');
    assert.deepStrictEqual(built.columns[2].values, ['1', '2', '3']);
  });

  test('a type override keeps an ID column textual', () => {
    const doc = ['| ID |', '| --- |', '| 1 |'].join('\n');
    const block = mdToDocBlocks(doc).blocks.find((entry) => entry.kind === 'table');
    assert.ok(block && block.kind === 'table');
    const built = sheetFromTable(block, { name: 'IDs', types: { ID: 'text' } });
    assert.strictEqual(built.columns[0].type, 'text');
    assert.strictEqual(built.rows[0][0], '1');
  });

  test('empty cells become null so they keep their column position', () => {
    const doc = ['| A | B |', '| --- | --- |', '| x |  |'].join('\n');
    const block = mdToDocBlocks(doc).blocks.find((entry) => entry.kind === 'table');
    assert.ok(block && block.kind === 'table');
    const built = sheetFromTable(block, { name: 'Sparse' });
    assert.strictEqual(built.rows[0][0], 'x');
    assert.strictEqual(built.rows[0][1], null);
  });

  test('a table-derived sheet produces a valid workbook end to end', () => {
    const built = sheetFromTable(firstTable(), { name: 'Requirements' });
    const result = buildWorkbookParts({
      title: 'RTM',
      generatedAt: TIMESTAMP,
      sheets: [infoSheet({ fields: [['Project', 'MyGov']] }), built],
    });
    assert.deepStrictEqual(result.sheetNames, ['Info', 'Requirements']);
    const xml = result.files['xl/worksheets/sheet2.xml'];
    assert.ok(xml.includes('<autoFilter ref="A1:D3"/>'));
    assert.ok(xml.includes(`s="${STYLE_DATE}"><v>45306</v>`));
    assert.ok(result.files['xl/sharedStrings.xml'].includes('<si><t>REQ-001</t></si>'));
  });
});
