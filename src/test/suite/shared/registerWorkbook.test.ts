import * as assert from 'assert';
import {
  buildRegisterWorkbook,
  linkHref,
  parseCsv,
  parseIsoDate,
  REGISTER_SPECS,
  registerSpec,
  summariseRegisters,
} from '../../../shared/documentation/registerWorkbook';
import {
  DOCUMENT_COLUMNS,
  DOC_STATUS_VALUES,
  EVIDENCE_COLUMNS,
  INPUT_COLUMNS,
  INPUT_STATUS_VALUES,
  MEDIA_COLUMNS,
  RESULT_VALUES,
  RTM_COLUMNS,
} from '../../../shared/documentation/columns';
import type { XlsxCellValue, XlsxColumn, XlsxSheet } from '../../../shared/xlsx';

const GENERATED = new Date(Date.UTC(2026, 0, 15, 9, 30, 0));

function headerOf(sheet: XlsxSheet): string[] {
  return sheet.columns.map((column: XlsxColumn) => column.header);
}

function sheet(result: ReturnType<typeof buildRegisterWorkbook>, name: string): XlsxSheet | undefined {
  return result.workbook.sheets.find((entry) => entry.name === name);
}

function columnOf(sheetOrUndefined: XlsxSheet | undefined, header: string): XlsxColumn | undefined {
  assert.ok(sheetOrUndefined, `expected a sheet`);
  return (sheetOrUndefined as XlsxSheet).columns.find((column) => column.header === header);
}

const RTM_CSV = [
  'REQ-ID,TITLE,SOURCE,ADO-WORK-ITEM,DESIGN-REF,TEST-CASE,UAT-STATUS,STATUS',
  'REQ-001,Submit application,BRD §3,27351,SRS §4.2,TC-001,Pass,Approved',
  'REQ-002,Amend application,BRD §4,,SRS §4.3,,Not Run,Draft',
  'REQ-003,Withdraw application,BRD §5,,SRS §4.4,TC-003,Fail,Draft',
].join('\r\n');

const EVIDENCE_CSV = [
  'EXEC-ID,TEST-CASE-ID,REQ-ID,SCENARIO,BUILD-VERSION,ENVIRONMENT,EXECUTED-UTC,EXECUTED-BY,WITNESSED-BY,STEP-REF,EXPECTED,ACTUAL,RESULT,DEFECT-ID,RETEST-OF,EVIDENCE,REMARKS',
  'EX-0001,TC-001,REQ-001,Submit happy path,1.0.3,SIT,2026-01-10T02:15:00Z,Siti,Azman,,Saved,   Saved,Pass,,,EVD-001,',
  'EX-0002,TC-001,REQ-001,Submit happy path,1.0.3,SIT,2026-01-10T02:40:00Z,Siti,Azman,,Saved,Saved,Pass,,,EVD-002,Retest',
  'EX-0003,TC-003,REQ-003,Withdraw rejected,1.0.3,SIT,2026-01-10T03:05:00Z,Siti,Azman,3,Withdrawn,Still active,Fail,DEF-001,,,',
  'EX-0004,TC-004,REQ-002,Amend blocked,1.0.3,SIT,2026-01-11T01:00:00Z,Lim,,,Amended,,Blocked,,,,',
].join('\n');

const MEDIA_CSV = [
  'MEDIA-ID,FILE,KIND,CAPTURED-UTC,HASH-SHA256,CLASSIFICATION,LINKED-ARTEFACT,CAPTION,NOTES',
  'EVD-001,assets/evidence/EVD-001.png,evidence,2026-01-10T02:15:00Z,abc123,INTERNAL,TC-001,Submit confirmation,',
  'DIA-001,diagrams/DIA-001-flow.png,diagram,2026-01-12T04:00:00Z,,INTERNAL,REQ-001,To-be flow,',
].join('\n');

const INPUTS_CSV = [
  'INPUT-ID,TYPE,RECEIVED-DATE,SOURCE-DATE,FILE,TITLE,FROM,LINKED-DOC,LINKED-REQ,STATUS,CLASSIFICATION,HASH-SHA256,NOTES',
  'IN-001,meeting-notes,2026-01-05,2026-01-04,inputs/brd/IN-001-kickoff.md,Kickoff notes,BA team,brs,,Incorporated,INTERNAL,def456,',
  'IN-002,whiteboard-sketch,2026-01-06,,inputs/brd/IN-002-sketch.png,Process sketch,Ops,,,Received,INTERNAL,,',
].join('\n');

suite('parseCsv', () => {
  test('reads a header and rows', () => {
    const parsed = parseCsv('A,B\r\n1,2\r\n3,4\r\n');
    assert.deepStrictEqual(parsed.header, ['A', 'B']);
    assert.deepStrictEqual(parsed.rows, [['1', '2'], ['3', '4']]);
    assert.deepStrictEqual(parsed.warnings, []);
  });

  test('keeps a quoted comma inside one cell', () => {
    const parsed = parseCsv('A,B\n"one, two",3\n');
    assert.deepStrictEqual(parsed.rows, [['one, two', '3']]);
  });

  test('keeps a newline inside a quoted cell', () => {
    const parsed = parseCsv('A,B\n"line one\nline two",3\n');
    assert.deepStrictEqual(parsed.rows, [['line one\nline two', '3']]);
  });

  test('unescapes a doubled quote', () => {
    const parsed = parseCsv('A\n"say ""hello"""\n');
    assert.deepStrictEqual(parsed.rows, [['say "hello"']]);
  });

  test('strips a UTF-8 BOM so the first header is not corrupted', () => {
    const parsed = parseCsv('\uFEFFREQ-ID,TITLE\nREQ-001,Thing\n');
    assert.deepStrictEqual(parsed.header, ['REQ-ID', 'TITLE']);
  });

  test('accepts LF, CRLF and a bare CR', () => {
    const lf = parseCsv('A,B\n1,2\n');
    const crlf = parseCsv('A,B\r\n1,2\r\n');
    const cr = parseCsv('A,B\r1,2\r');
    assert.deepStrictEqual(lf.rows, crlf.rows);
    assert.deepStrictEqual(lf.rows, cr.rows);
  });

  test('pads short rows and truncates long ones with a warning', () => {
    const parsed = parseCsv('A,B,C\n1,2\n1,2,3,4\n');
    assert.deepStrictEqual(parsed.rows, [['1', '2', ''], ['1', '2', '3']]);
    assert.strictEqual(parsed.warnings.length, 1);
    assert.match(parsed.warnings[0], /1 row\(s\) had more cells/);
  });

  test('skips blank lines and a trailing newline', () => {
    const parsed = parseCsv('A,B\n\n1,2\n\n');
    assert.deepStrictEqual(parsed.rows, [['1', '2']]);
  });

  test('returns nothing for an empty document', () => {
    assert.deepStrictEqual(parseCsv(''), { header: [], rows: [], warnings: [] });
    assert.deepStrictEqual(parseCsv('\r\n\r\n'), { header: [], rows: [], warnings: [] });
  });

  test('trims header names but leaves cell content untouched', () => {
    const parsed = parseCsv(' REQ-ID , TITLE \nREQ-001, padded value \n');
    assert.deepStrictEqual(parsed.header, ['REQ-ID', 'TITLE']);
    // The reader stays literal; cell-level trimming happens during coercion, so
    // a value that is genuinely padded survives in the CSV round trip.
    assert.deepStrictEqual(parsed.rows, [['REQ-001', ' padded value ']]);
  });
});

suite('parseIsoDate', () => {
  test('parses a date-only value at midnight UTC', () => {
    const parsed = parseIsoDate('2026-01-05', false);
    assert.ok(parsed instanceof Date);
    assert.strictEqual((parsed as Date).toISOString(), '2026-01-05T00:00:00.000Z');
  });

  test('parses a date-time with and without seconds', () => {
    assert.strictEqual((parseIsoDate('2026-01-10T02:15:00Z', true) as Date).toISOString(), '2026-01-10T02:15:00.000Z');
    assert.strictEqual((parseIsoDate('2026-01-10 02:15', true) as Date).toISOString(), '2026-01-10T02:15:00.000Z');
  });

  test('rejects a rolled-over calendar date rather than silently accepting it', () => {
    assert.strictEqual(parseIsoDate('2026-13-45', false), 'INVALID');
    assert.strictEqual(parseIsoDate('2026-02-30', false), 'INVALID');
  });

  test('rejects free text', () => {
    assert.strictEqual(parseIsoDate('last Tuesday', false), 'INVALID');
  });

  test('returns an empty string for a blank cell', () => {
    assert.strictEqual(parseIsoDate('   ', false), '');
  });
});

suite('linkHref', () => {
  test('prefixes a project-relative path for a workbook in export/out', () => {
    assert.strictEqual(linkHref('assets/img/FIG-001.png'), '../../assets/img/FIG-001.png');
  });

  test('does not stack a second relative prefix', () => {
    assert.strictEqual(linkHref('./assets/img/FIG-001.png'), '../../assets/img/FIG-001.png');
  });

  test('refuses a bare id, because it is not a path', () => {
    assert.strictEqual(linkHref('EVD-001'), undefined);
  });

  test('refuses a multi-file cell rather than linking the first one', () => {
    assert.strictEqual(linkHref('assets/a.png, assets/b.png'), undefined);
  });

  test('refuses a URL', () => {
    assert.strictEqual(linkHref('https://example.gov.my/a.png'), undefined);
  });
});

suite('register workbook — sheets', () => {
  test('every register sheet header equals its column contract', () => {
    const result = buildRegisterWorkbook({
      projectName: 'docproj',
      role: 'Tester',
      generatedAt: GENERATED,
      registers: [
        { kind: 'documents', csv: '' },
        { kind: 'rtm', csv: RTM_CSV },
        { kind: 'media', csv: MEDIA_CSV },
        { kind: 'inputs', csv: INPUTS_CSV },
        { kind: 'evidence', csv: EVIDENCE_CSV },
      ],
    });

    assert.deepStrictEqual(headerOf(sheet(result, 'RTM') as XlsxSheet), [...RTM_COLUMNS]);
    assert.deepStrictEqual(headerOf(sheet(result, 'Documents') as XlsxSheet), [...DOCUMENT_COLUMNS]);
    assert.deepStrictEqual(headerOf(sheet(result, 'Media') as XlsxSheet), [...MEDIA_COLUMNS]);
    assert.deepStrictEqual(headerOf(sheet(result, 'Inputs') as XlsxSheet), [...INPUT_COLUMNS]);
    assert.deepStrictEqual(headerOf(sheet(result, 'Test evidence') as XlsxSheet), [...EVIDENCE_COLUMNS]);
  });

  test('starts with a README sheet that names the source of truth', () => {
    const result = buildRegisterWorkbook({
      projectName: 'docproj',
      role: 'BA',
      version: '0.1.0',
      generatedAt: GENERATED,
      registers: [{ kind: 'rtm', csv: RTM_CSV }],
    });
    const readme = result.workbook.sheets[0];
    assert.strictEqual(readme.name, 'README');
    const flat = JSON.stringify(readme.rows);
    assert.match(flat, /docproj/);
    assert.match(flat, /Business Analysis/);
    assert.match(flat, /0\.1\.0/);
  });

  test('gives the tester a test-evidence sheet and a writer none', () => {
    const registers = [{ kind: 'evidence' as const, csv: EVIDENCE_CSV }];

    const tester = buildRegisterWorkbook({ projectName: 'p', role: 'Tester', generatedAt: GENERATED, registers });
    assert.ok(sheet(tester, 'Test evidence'));

    const writer = buildRegisterWorkbook({ projectName: 'p', role: 'Writer', generatedAt: GENERATED, registers });
    assert.strictEqual(sheet(writer, 'Test evidence'), undefined);
    assert.ok(writer.warnings.some((warning) => /only the README sheet/.test(warning)));
  });

  test('type-specific STATUS vocabulary is taken per register, not globally', () => {
    const result = buildRegisterWorkbook({
      projectName: 'p',
      role: 'Tester',
      generatedAt: GENERATED,
      registers: [
        { kind: 'documents', csv: 'DOC-ID,TITLE\nDOC-001,BRD\n' },
        { kind: 'inputs', csv: 'INPUT-ID,TYPE\nIN-001,meeting-notes\n' },
      ],
    });

    assert.deepStrictEqual(columnOf(sheet(result, 'Documents'), 'STATUS')?.values, [...DOC_STATUS_VALUES]);
    assert.deepStrictEqual(columnOf(sheet(result, 'Inputs'), 'STATUS')?.values, [...INPUT_STATUS_VALUES]);
  });

  test('enumerated columns carry their dropdown vocabulary', () => {
    const result = buildRegisterWorkbook({
      projectName: 'p',
      role: 'Tester',
      generatedAt: GENERATED,
      registers: [{ kind: 'evidence', csv: EVIDENCE_CSV }],
    });
    const evidence = sheet(result, 'Test evidence') as XlsxSheet;
    assert.deepStrictEqual(columnOf(evidence, 'RESULT')?.values, [...RESULT_VALUES]);
    assert.deepStrictEqual(columnOf(evidence, 'ENVIRONMENT')?.values, ['DEV', 'SIT', 'UAT', 'STG', 'PROD']);
  });

  test('freezes the header and filters the used range', () => {
    const result = buildRegisterWorkbook({
      projectName: 'p',
      role: 'BA',
      generatedAt: GENERATED,
      registers: [{ kind: 'rtm', csv: RTM_CSV }],
    });
    const rtm = sheet(result, 'RTM') as XlsxSheet;
    assert.strictEqual(rtm.freezeHeader, true);
    assert.strictEqual(rtm.autoFilter, true);
  });

  test('specs stay discoverable by kind', () => {
    assert.strictEqual(registerSpec('rtm')?.csvPath, '05-traceability/rtm.csv');
    assert.strictEqual(REGISTER_SPECS.length, 5);
  });
});

suite('register workbook — cell values', () => {
  test('converts dates to real date cells', () => {
    const result = buildRegisterWorkbook({
      projectName: 'p',
      role: 'Tester',
      generatedAt: GENERATED,
      registers: [{ kind: 'evidence', csv: EVIDENCE_CSV }],
    });
    const evidence = sheet(result, 'Test evidence') as XlsxSheet;
    const executedIndex = headerOf(evidence).indexOf('EXECUTED-UTC');
    const cell = evidence.rows[0][executedIndex];
    assert.ok(cell instanceof Date, `expected a Date, got ${String(cell)}`);
    assert.strictEqual((cell as Date).toISOString(), '2026-01-10T02:15:00.000Z');
  });

  test('keeps a non-ISO date as text and reports it once', () => {
    const csv = [
      'EXEC-ID,TEST-CASE-ID,EXECUTED-UTC,RESULT',
      'EX-0001,TC-001,sometime last week,Pass',
      'EX-0002,TC-002,10/01/2026,Pass',
    ].join('\n');

    const result = buildRegisterWorkbook({ projectName: 'p', role: 'Tester', generatedAt: GENERATED, registers: [{ kind: 'evidence', csv }] });
    const evidence = sheet(result, 'Test evidence') as XlsxSheet;
    const index = headerOf(evidence).indexOf('EXECUTED-UTC');
    assert.strictEqual(evidence.rows[0][index], 'sometime last week');
    const dateWarnings = result.warnings.filter((warning) => /EXECUTED-UTC/.test(warning));
    assert.strictEqual(dateWarnings.length, 1, 'the two bad dates must collapse into one warning');
    assert.match(dateWarnings[0], /2 value\(s\)/);
  });

  test('collapses out-of-vocabulary values into one aggregated warning', () => {
    const csv = [
      'EXEC-ID,TEST-CASE-ID,RESULT',
      'EX-0001,TC-001,PASS',
      'EX-0002,TC-002,pass',
      'EX-0003,TC-003,Pass',
    ].join('\n');

    const result = buildRegisterWorkbook({ projectName: 'p', role: 'Tester', generatedAt: GENERATED, registers: [{ kind: 'evidence', csv }] });
    const evidence = sheet(result, 'Test evidence') as XlsxSheet;
    const index = headerOf(evidence).indexOf('RESULT');
    assert.strictEqual(evidence.rows[0][index], 'PASS', 'the value is preserved, not corrected');

    const warnings = result.warnings.filter((warning) => /outside its vocabulary/.test(warning));
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /RESULT outside its vocabulary: 2 value\(s\)/);
  });

  test('links a project-relative file but leaves a bare id as text', () => {
    const result = buildRegisterWorkbook({
      projectName: 'p',
      role: 'Tester',
      generatedAt: GENERATED,
      registers: [{ kind: 'media', csv: MEDIA_CSV }, { kind: 'evidence', csv: EVIDENCE_CSV }],
    });

    const media = sheet(result, 'Media') as XlsxSheet;
    const fileIndex = headerOf(media).indexOf('FILE');
    const link = media.rows[0][fileIndex] as { text: string; href?: string };
    assert.strictEqual(link.text, 'assets/evidence/EVD-001.png');
    assert.strictEqual(link.href, '../../assets/evidence/EVD-001.png');

    const evidence = sheet(result, 'Test evidence') as XlsxSheet;
    const evidenceIndex = headerOf(evidence).indexOf('EVIDENCE');
    assert.strictEqual(evidence.rows[0][evidenceIndex], 'EVD-001');
  });

  test('appends a column that is not in the contract and says so', () => {
    const csv = ['REQ-ID,TITLE,TEAM-COMMENT', 'REQ-001,Submit,Front desk asked'].join('\n');
    const result = buildRegisterWorkbook({ projectName: 'p', role: 'BA', generatedAt: GENERATED, registers: [{ kind: 'rtm', csv }] });

    const rtm = sheet(result, 'RTM') as XlsxSheet;
    assert.deepStrictEqual(headerOf(rtm).slice(-1), ['TEAM-COMMENT']);
    assert.strictEqual(headerOf(rtm).length, RTM_COLUMNS.length + 1);
    assert.strictEqual(rtm.rows[0][headerOf(rtm).length - 1], 'Front desk asked');
    assert.ok(result.warnings.some((warning) => /not in the contract, appended/.test(warning)));
  });

  test('reports a contract column that the CSV does not have', () => {
    const csv = ['REQ-ID,TITLE', 'REQ-001,Submit'].join('\n');
    const result = buildRegisterWorkbook({ projectName: 'p', role: 'BA', generatedAt: GENERATED, registers: [{ kind: 'rtm', csv }] });
    assert.ok(result.warnings.some((warning) => /column\(s\) missing from 05-traceability\/rtm\.csv/.test(warning)));
  });

  test('emits an empty sheet rather than no sheet when the register is absent', () => {
    const result = buildRegisterWorkbook({
      projectName: 'p',
      role: 'BA',
      generatedAt: GENERATED,
      registers: [{ kind: 'rtm', csv: undefined }],
    });

    const rtm = sheet(result, 'RTM') as XlsxSheet;
    assert.ok(rtm, 'the sheet must still exist so the structure is visible');
    assert.deepStrictEqual(headerOf(rtm), [...RTM_COLUMNS]);
    assert.deepStrictEqual(rtm.rows, []);
    assert.strictEqual(rtm.autoFilter, false);
    assert.ok(result.warnings.some((warning) => /was not found/.test(warning)));
  });

  test('leaves blank cells blank rather than writing empty strings', () => {
    const result = buildRegisterWorkbook({ projectName: 'p', role: 'BA', generatedAt: GENERATED, registers: [{ kind: 'rtm', csv: RTM_CSV }] });
    const rtm = sheet(result, 'RTM') as XlsxSheet;
    const adoIndex = headerOf(rtm).indexOf('ADO-WORK-ITEM');
    assert.strictEqual(rtm.rows[1][adoIndex], undefined);
  });
});

suite('register workbook — summary', () => {
  const result = buildRegisterWorkbook({
    projectName: 'docproj',
    role: 'Tester',
    generatedAt: GENERATED,
    registers: [
      { kind: 'rtm', csv: RTM_CSV },
      { kind: 'media', csv: MEDIA_CSV },
      { kind: 'inputs', csv: INPUTS_CSV },
      { kind: 'evidence', csv: EVIDENCE_CSV },
    ],
  });

  const value = (label: string): XlsxCellValue => {
    const line = result.summary.find((entry) => entry.label === label);
    assert.ok(line, `missing summary line: ${label}`);
    return line!.value;
  };

  test('counts executions by result', () => {
    assert.strictEqual(value('Test executions recorded'), 4);
    assert.strictEqual(value('Executions passed'), 2);
    assert.strictEqual(value('Executions failed'), 1);
    assert.strictEqual(value('Executions blocked'), 1);
    assert.strictEqual(value('Executions not run'), 0);
  });

  test('counts evidence coverage', () => {
    assert.strictEqual(value('Executions with evidence attached'), 2);
    assert.strictEqual(value('Executions with evidence attached (%)'), 50);
  });

  test('flags the failure that has no evidence attached', () => {
    assert.strictEqual(value('Failures without evidence'), 1);
  });

  test('derives requirement coverage from the RTM', () => {
    assert.strictEqual(value('Requirements tracked'), 3);
    assert.strictEqual(value('Requirements linked to a work item'), 1);
    assert.strictEqual(value('Requirements with a test case'), 2);
    assert.strictEqual(value('Requirements with a test case (%)'), 67);
    assert.strictEqual(value('Requirements UAT-passed'), 1);
  });

  test('flags media registered without a hash', () => {
    assert.strictEqual(value('Media files registered'), 2);
    assert.strictEqual(value('Media files with a SHA-256'), 1);
    assert.strictEqual(value('Media files missing a SHA-256'), 1);
  });

  test('flags inputs not yet incorporated', () => {
    assert.strictEqual(value('Source inputs received'), 2);
    assert.strictEqual(value('Inputs incorporated'), 1);
    assert.strictEqual(value('Inputs outstanding'), 1);
  });

  test('writes the same numbers onto the Summary sheet', () => {
    const summarySheet = sheet(result, 'Summary') as XlsxSheet;
    assert.ok(summarySheet);
    assert.strictEqual(summarySheet.rows.length, result.summary.length);
    assert.deepStrictEqual(summarySheet.rows[0], ['Requirements tracked', 3]);
  });

  test('summariseRegisters tolerates a subset of registers', () => {
    const lines = summariseRegisters({});
    assert.deepStrictEqual(lines, []);
  });
});

suite('register workbook — determinism', () => {
  test('two builds with the same timestamp are byte-identical', () => {
    const build = () =>
      buildRegisterWorkbook({
        projectName: 'docproj',
        role: 'Tester',
        version: '1.2.3',
        generatedAt: GENERATED,
        registers: [
          { kind: 'rtm', csv: RTM_CSV },
          { kind: 'media', csv: MEDIA_CSV },
          { kind: 'evidence', csv: EVIDENCE_CSV },
        ],
      });

    assert.deepStrictEqual(JSON.stringify(build().workbook), JSON.stringify(build().workbook));
  });

  test('does not mutate the CSV source it was given', () => {
    const csv = 'REQ-ID,TITLE\nREQ-001,Submit\n';
    buildRegisterWorkbook({ projectName: 'p', role: 'BA', generatedAt: GENERATED, registers: [{ kind: 'rtm', csv }] });
    assert.strictEqual(csv, 'REQ-ID,TITLE\nREQ-001,Submit\n');
  });
});
