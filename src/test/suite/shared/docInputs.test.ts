import * as assert from 'assert';
import {
  GENERAL_INPUT_SLUG,
  INPUT_RECORDING_PATTERNS,
  INPUT_REGISTER_PATH,
  INPUTS_FOLDER,
  InputDocRef,
  inputFolderSlug,
  inputFolders,
  exampleInputFolder,
  inputRegisterExampleRow,
  isSourcedDocType,
  renderInputFolderReadme,
  renderInputsReadme,
} from '../../../shared/documentation/docInputs';
import { INPUT_COLUMNS, INPUT_STATUS_VALUES, INPUT_TYPE_VALUES } from '../../../shared/documentation/columns';

/**
 * Source inputs are the provenance of every requirement, so the folder layout
 * and the register row shape are pinned here rather than left to the scaffolder.
 */

const FILES: InputDocRef[] = [
  { path: '01-business-analysis/brs.md', docType: 'BRD', titleEn: 'Business Requirements', titleBm: 'Keperluan Bisnes' },
  {
    path: '01-business-analysis/functional-requirements.md',
    docType: 'FRS',
    titleEn: 'Functional Requirements',
    titleBm: 'Keperluan Fungsian',
  },
  { path: '05-traceability/rtm.md', docType: 'RTM', titleEn: 'Traceability Matrix', titleBm: 'Matriks Surih' },
];

const DOC_IDS: Record<string, string> = {
  '01-business-analysis/brs.md': 'docproj-BA-BRD-001',
  '01-business-analysis/functional-requirements.md': 'docproj-BA-FRS-001',
  '05-traceability/rtm.md': 'docproj-BA-RTM-001',
};

suite('documentation · source inputs', () => {
  test('slugs a document type into a folder-safe name', () => {
    assert.strictEqual(inputFolderSlug('BRD'), 'brd');
    assert.strictEqual(inputFolderSlug('User Manual'), 'user-manual');
    assert.strictEqual(inputFolderSlug('  uat  '), 'uat');
    assert.strictEqual(inputFolderSlug(''), 'doc');
    assert.strictEqual(inputFolderSlug('---'), 'doc');
  });

  test('derived documents get no input folder of their own', () => {
    assert.strictEqual(isSourcedDocType('BRD'), true);
    assert.strictEqual(isSourcedDocType('brd'), true, 'case must not matter');
    for (const derived of ['RTM', 'KCM', 'CRL', 'GLS', 'DCT']) {
      assert.strictEqual(isSourcedDocType(derived), false, `${derived} is derived, not sourced`);
    }
  });

  test('one folder per sourced document, plus a catch-all', () => {
    const folders = inputFolders(FILES, DOC_IDS);
    const slugs = folders.map((folder) => folder.slug);
    assert.deepStrictEqual(slugs, ['brd', 'frs', GENERAL_INPUT_SLUG]);
    assert.ok(!slugs.includes('rtm'), 'the traceability matrix is generated from other documents');
  });

  test('folders carry project-relative paths and the document they feed', () => {
    const [brd] = inputFolders(FILES, DOC_IDS);
    assert.strictEqual(brd.folder, `${INPUTS_FOLDER}/brd`);
    assert.deepStrictEqual(brd.docIds, ['docproj-BA-BRD-001']);
    assert.deepStrictEqual(brd.docPaths, ['01-business-analysis/brs.md']);
    assert.ok(brd.hint.length > 10, 'the folder must say what belongs in it');
  });

  test('two documents of the same type share one folder', () => {
    const folders = inputFolders(
      [
        { path: 'a/uat-plan.md', docType: 'UAP', titleEn: 'UAT Plan', titleBm: 'Pelan UAT' },
        { path: 'a/uat-script.md', docType: 'UAP', titleEn: 'UAT Script', titleBm: 'Skrip UAT' },
      ],
      { 'a/uat-plan.md': 'P-1', 'a/uat-script.md': 'P-2' }
    );
    const uap = folders.find((folder) => folder.slug === 'uap')!;
    assert.deepStrictEqual(uap.docIds, ['P-1', 'P-2']);
    assert.deepStrictEqual(uap.titles, ['UAT Plan', 'UAT Script']);
  });

  test('the catch-all folder always exists, even with no sourced documents', () => {
    const folders = inputFolders([], {});
    assert.strictEqual(folders.length, 1);
    assert.strictEqual(folders[0].slug, GENERAL_INPUT_SLUG);
    assert.deepStrictEqual(folders[0].docIds, []);
  });

  test('the index README lists every folder with the document it feeds', () => {
    const folders = inputFolders(FILES, DOC_IDS);
    const readme = renderInputsReadme({
      projectName: 'docproj',
      roleLabel: 'Business Analysis',
      lang: 'en',
      classification: 'INTERNAL',
      folders,
    });
    for (const folder of folders) {
      assert.ok(readme.includes(`\`${folder.folder}/\``), `missing row for ${folder.folder}`);
    }
    assert.ok(readme.includes('docproj-BA-BRD-001'));
    assert.ok(readme.includes(INPUT_REGISTER_PATH));
    assert.ok(readme.includes('LINKED-REQ'), 'the README must explain the requirement link');
    assert.ok(readme.includes('Redact personal data'));
  });

  test('a Bahasa Malaysia project gets BM guidance and still keeps the EN rules', () => {
    const readme = renderInputsReadme({
      projectName: 'docproj',
      roleLabel: 'Business Analysis',
      lang: 'ms',
      classification: 'TERHAD',
      folders: inputFolders(FILES, DOC_IDS),
    });
    assert.ok(readme.includes('Input sumber'));
    assert.ok(readme.includes('TERHAD'));
    assert.ok(readme.includes('LINKED-DOC'));
  });

  test('the per-folder README names the document and the registration checklist', () => {
    const [brd] = inputFolders(FILES, DOC_IDS);
    const readme = renderInputFolderReadme({
      projectName: 'docproj',
      folder: brd,
      lang: 'en',
      classification: 'INTERNAL',
    });
    assert.ok(readme.includes('docproj-BA-BRD-001'));
    assert.ok(readme.includes('01-business-analysis/brs.md'));
    assert.ok(readme.includes('## What belongs here'));
    assert.ok(readme.includes('source-register.csv'));
    assert.ok(readme.includes('- [ ] '), 'the checklist must be tickable');
  });

  test('the example register row fits the column contract exactly', () => {
    const [brd] = inputFolders(FILES, DOC_IDS);
    const row = inputRegisterExampleRow({ folder: brd, classification: 'TERHAD' });
    assert.strictEqual(row.length, INPUT_COLUMNS.length);
    assert.strictEqual(row[0], 'IN-001');
    assert.strictEqual(row[INPUT_COLUMNS.indexOf('CLASSIFICATION')], 'TERHAD');
    assert.strictEqual(row[INPUT_COLUMNS.indexOf('LINKED-DOC')], 'docproj-BA-BRD-001');
    assert.strictEqual(row[INPUT_COLUMNS.indexOf('STATUS')], 'Received');
    assert.ok(row[INPUT_COLUMNS.indexOf('FILE')].startsWith(`${INPUTS_FOLDER}/brd/IN-001-`));
  });

  test('recordings are excluded from git but every pattern targets the inputs tree', () => {
    assert.ok(INPUT_RECORDING_PATTERNS.length > 0);
    for (const pattern of INPUT_RECORDING_PATTERNS) {
      assert.ok(/^\*\.(mp3|mp4|wav|m4a|mov|mkv|webm)$/.test(pattern), `unexpected pattern ${pattern}`);
    }
  });

  test('the example row only uses registered vocabularies', () => {
    const folders = inputFolders(FILES, DOC_IDS);
    const row = inputRegisterExampleRow({ folder: exampleInputFolder(folders)!, classification: 'INTERNAL' });
    const value = (column: string) => row[(INPUT_COLUMNS as readonly string[]).indexOf(column)];
    assert.ok(
      (INPUT_TYPE_VALUES as readonly string[]).includes(value('TYPE')),
      `TYPE "${value('TYPE')}" is not in INPUT_TYPE_VALUES`
    );
    assert.ok(
      (INPUT_STATUS_VALUES as readonly string[]).includes(value('STATUS')),
      `STATUS "${value('STATUS')}" is not in INPUT_STATUS_VALUES`
    );
  });

  test('the example row points at a requirements-shaped folder when one exists', () => {
    const folders = inputFolders(
      [
        { path: '00-project-control/project-charter.md', docType: 'CHT', titleEn: 'Charter', titleBm: 'Piagam' },
        { path: '01-business-analysis/functional-requirements.md', docType: 'FRS', titleEn: 'FRS', titleBm: 'FRS' },
      ],
      { '00-project-control/project-charter.md': 'P-CHT', '01-business-analysis/functional-requirements.md': 'P-FRS' }
    );
    assert.strictEqual(exampleInputFolder(folders)!.slug, 'frs');
  });

  test('with only a catch-all folder the example still points somewhere valid', () => {
    const folders = inputFolders([], {});
    const folder = exampleInputFolder(folders)!;
    assert.strictEqual(folder.slug, GENERAL_INPUT_SLUG);
    const row = inputRegisterExampleRow({ folder, classification: 'INTERNAL' });
    assert.strictEqual(row.length, INPUT_COLUMNS.length);
  });
});
