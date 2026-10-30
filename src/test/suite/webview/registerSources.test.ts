import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  DOCUMENTATION_RECORD_PATH,
  collectRegisterSources,
  isDocRole,
  workbookFileName,
} from '../../../webview/documentation/registerSources';
import { buildRegisterWorkbook } from '../../../shared/documentation/registerWorkbook';
import { makeScratchDir } from '../utils/scratchDir';

const RTM_CSV = ['REQ-ID,TITLE,SOURCE,ADO-WORK-ITEM,DESIGN-REF,TEST-CASE,UAT-STATUS,STATUS', 'REQ-001,Submit,BRD 3,,SRS 4.2,TC-001,Pass,Approved'].join('\r\n');

const tempDirs: string[] = [];

function makeProject(files: Record<string, string>): string {
  const root = makeScratchDir('ado-docs-reg-');
  tempDirs.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  return root;
}

const uri = (root: string) => vscode.Uri.file(root);

const record = (extra: Record<string, unknown>) =>
  JSON.stringify({ project: 'docproj', role: 'Tester', documentVersion: '0.1.0', xlsxExport: 'Registers + summary', ...extra });

suite('documentation register collection', () => {
  suiteSetup(() => {
    // Nothing global: each test builds its own project.
  });

  teardown(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop() as string;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows keeps a handle briefly; the temp dir is harmless.
      }
    }
  });

  test('refuses a folder that is not a documentation project', async () => {
    const root = makeProject({ 'README.md': '# not a doc project' });
    const collected = await collectRegisterSources(uri(root));

    assert.strictEqual(collected.ok, false);
    assert.match(String(collected.reason), /not a documentation project/);
    assert.deepStrictEqual(collected.sources, []);
  });

  test('reads the record and the CSVs the role owns', async () => {
    const root = makeProject({
      [DOCUMENTATION_RECORD_PATH]: record({}),
      '05-traceability/rtm.csv': RTM_CSV,
      'assets/media-register.csv': 'MEDIA-ID,FILE\nEVD-001,assets/evidence/EVD-001.png\n',
      '04-defects/test-evidence-register.csv': 'EXEC-ID,RESULT\nEX-0001,Pass\n',
    });

    const collected = await collectRegisterSources(uri(root));
    assert.strictEqual(collected.ok, true);
    assert.strictEqual(collected.role, 'Tester');
    assert.strictEqual(collected.projectName, 'docproj');
    assert.deepStrictEqual(collected.present, ['rtm', 'media', 'evidence']);
    assert.deepStrictEqual(collected.missing, ['documents', 'inputs']);
    assert.strictEqual(collected.sources.length, 3);
    assert.match(String(collected.sources[0].csv), /REQ-001/);
  });

  test('omits a register the project deliberately does not have', async () => {
    const root = makeProject({
      [DOCUMENTATION_RECORD_PATH]: JSON.stringify({ project: 'p', role: 'BA' }),
      '05-traceability/rtm.csv': RTM_CSV,
    });

    const collected = await collectRegisterSources(uri(root));
    assert.deepStrictEqual(collected.present, ['rtm']);
    assert.ok(!collected.sources.some((source) => source.kind === 'documents'), 'a dropped register must not become an empty sheet');
  });

  test('falls back to empty shells when the project has no register at all', async () => {
    const root = makeProject({ [DOCUMENTATION_RECORD_PATH]: JSON.stringify({ project: 'p', role: 'Writer' }) });

    const collected = await collectRegisterSources(uri(root));
    assert.strictEqual(collected.ok, true);
    assert.deepStrictEqual(collected.present, []);
    assert.strictEqual(collected.sources.length, 4, 'writer owns documents, rtm, media and inputs');
    assert.ok(collected.sources.every((source) => source.csv === undefined));
    assert.ok(collected.warnings.some((warning) => /No register CSV was found/.test(warning)));
  });

  test('defaults the role and says so when the record is unusable', async () => {
    const root = makeProject({
      [DOCUMENTATION_RECORD_PATH]: 'not json at all',
      '05-traceability/rtm.csv': RTM_CSV,
    });

    const collected = await collectRegisterSources(uri(root));
    assert.strictEqual(collected.role, 'BA');
    assert.ok(collected.warnings.some((warning) => /not valid JSON/.test(warning)));
    assert.ok(collected.warnings.some((warning) => /assuming Business Analysis/.test(warning)));
  });

  test('falls back to the folder name when the record has no project name', async () => {
    const root = makeProject({ [DOCUMENTATION_RECORD_PATH]: JSON.stringify({ role: 'BA' }) });
    const collected = await collectRegisterSources(uri(root));
    assert.strictEqual(collected.projectName, path.basename(root));
  });

  test('suggests a Windows-safe workbook file name', () => {
    assert.strictEqual(workbookFileName('docproj'), 'docproj-registers.xlsx');
    assert.strictEqual(workbookFileName('My Project: Phase 2'), 'My-Project-Phase-2-registers.xlsx');
    assert.strictEqual(workbookFileName('   '), 'documentation-registers.xlsx');
    assert.strictEqual(workbookFileName('a/b\\c'), 'a-b-c-registers.xlsx');
  });

  test('only the three documented roles are accepted', () => {
    assert.strictEqual(isDocRole('BA'), true);
    assert.strictEqual(isDocRole('Tester'), true);
    assert.strictEqual(isDocRole('tester'), false);
    assert.strictEqual(isDocRole(undefined), false);
  });

  test('collection feeds the workbook builder end to end', async () => {
    const root = makeProject({
      [DOCUMENTATION_RECORD_PATH]: record({ version: '0.1.0' }),
      '05-traceability/rtm.csv': RTM_CSV,
      '04-defects/test-evidence-register.csv': 'EXEC-ID,TEST-CASE-ID,RESULT\nEX-0001,TC-001,Pass\nEX-0002,TC-001,Fail\n',
    });

    const collected = await collectRegisterSources(uri(root));
    const built = buildRegisterWorkbook({
      projectName: collected.projectName,
      role: collected.role,
      version: collected.record.documentVersion,
      framework: collected.record.framework,
      generatedAt: new Date(Date.UTC(2026, 0, 15)),
      registers: collected.sources,
    });

    assert.deepStrictEqual(built.sheets.map((sheet) => sheet.kind), ['rtm', 'evidence', 'summary']);
    const executions = built.summary.find((line) => line.label === 'Test executions recorded');
    assert.strictEqual(executions?.value, 2);
  });
});
