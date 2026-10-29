import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProjectCreationService } from '../../../webview/ProjectCreationService';
import {
  PROJECT_TEMPLATES,
  ProjectCreationRequest,
} from '../../../webview-ui/src/components/ProjectCreationWizard/types';
import {
  DOCUMENT_COLUMNS,
  EVIDENCE_COLUMNS,
  MEDIA_COLUMNS,
  RTM_COLUMNS,
  csvHeader,
  INPUT_COLUMNS,
} from '../../../shared/documentation/columns';
import { KRISA_ARTEFACTS, krisaArtefactsForRole } from '../../../shared/documentation/krisa';
import { cleanTempDir } from '../utils/cleanTempDir';
import { makeScratchDir } from '../utils/scratchDir';

const DOC_TEMPLATES = ['doc-ba', 'doc-writer', 'doc-tester'] as const;
type DocTemplateId = (typeof DOC_TEMPLATES)[number];

const ROLES: Record<DocTemplateId, string> = {
  'doc-ba': 'BA',
  'doc-writer': 'Writer',
  'doc-tester': 'Tester',
};

suite('Documentation project scaffolding', () => {
  const service = new ProjectCreationService();

  function defaultsFor(templateId: string): Record<string, any> {
    const template = PROJECT_TEMPLATES.find((t) => t.id === templateId);
    const defaults: Record<string, any> = {};
    template?.options.forEach((o) => {
      defaults[o.id] = o.default;
    });
    return defaults;
  }

  function makeRequest(
    templateId: DocTemplateId,
    options: Record<string, any> = {}
  ): ProjectCreationRequest {
    return {
      templateId,
      projectName: 'docproj',
      projectDescription: 'Documentation project under test',
      projectVersion: '1.2.3',
      templateOptions: { ...defaultsFor(templateId), ...options },
      adoIntegration: false,
      adoWorkItemType: 'Task',
      adoAreaPath: '',
      gitInit: false,
      gitInitialCommit: false,
      gitBranchName: 'main',
      targetPath: makeScratchDir('ado-doc-test-'),
    };
  }

  function read(dir: string, relative: string): string {
    return fs.readFileSync(path.join(dir, ...relative.split('/')), 'utf8');
  }

  function exists(dir: string, relative: string): boolean {
    return fs.existsSync(path.join(dir, ...relative.split('/')));
  }

  function headerOf(csv: string): string {
    const withoutBom = csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv;
    return withoutBom.split(/\r?\n/)[0];
  }

  function record(dir: string): any {
    return JSON.parse(read(dir, '.ado-code/documentation.json'));
  }

  teardown(() => {
    for (const entry of fs.readdirSync(os.tmpdir())) {
      if (entry.startsWith('ado-doc-test-')) {
        cleanTempDir(path.join(os.tmpdir(), entry));
      }
    }
  });

  // ── Templates are registered with the wizard ─────────────────────
  test('the wizard exposes the three documentation templates', () => {
    for (const templateId of DOC_TEMPLATES) {
      const template = PROJECT_TEMPLATES.find((t) => t.id === templateId);
      assert.ok(template, `${templateId} is not registered`);
      assert.strictEqual(template!.category, 'documentation');
      assert.ok(template!.options.length > 5);
    }
  });

  test('documentation templates share the governance/language/export option ids', () => {
    const shared = ['governance', 'docLanguage', 'docControl', 'wordExport', 'xlsxExport', 'krisaCompliance', 'traceability'];
    const templateOptions = DOC_TEMPLATES.map(
      (id) => new Set(PROJECT_TEMPLATES.find((t) => t.id === id)!.options.map((o) => o.id))
    );
    for (const optionId of shared) {
      for (const ids of templateOptions) {
        assert.ok(ids.has(optionId), `missing shared option ${optionId}`);
      }
    }
  });

  // ── Default scaffolds ────────────────────────────────────────────
  for (const templateId of DOC_TEMPLATES) {
    test(`scaffolds ${templateId} with default options`, async () => {
      const request = makeRequest(templateId);
      const result = await service.createProject(request);

      assert.strictEqual(result.success, true, result.error);
      const dir = result.path;
      assert.ok(exists(dir, 'README.md'));
      assert.ok(exists(dir, '.ado-code/documentation.json'));

      const meta = record(dir);
      assert.strictEqual(meta.template, templateId);
      assert.strictEqual(meta.role, ROLES[templateId]);
      assert.strictEqual(meta.framework, 'Standard');
      assert.strictEqual(meta.project, 'docproj');
      assert.strictEqual(meta.documentVersion, '1.2.3');
      assert.ok(Array.isArray(meta.linkedProjects), 'linkedProjects must exist for cross-project joins');

      // Defaults write the pandoc pipeline and the media register.
      assert.ok(exists(dir, 'export/pandoc.yaml'));
      assert.ok(exists(dir, 'export/export.ps1'));
      assert.ok(exists(dir, 'assets/media-register.csv'));
      assert.ok(exists(dir, 'assets/README.md'));

      // Registers use the shared column contract.
      assert.strictEqual(headerOf(read(dir, 'assets/media-register.csv')), csvHeader(MEDIA_COLUMNS));
      assert.strictEqual(
        headerOf(read(dir, '00-project-control/document-register.csv')),
        csvHeader(DOCUMENT_COLUMNS)
      );

      // .gitignore keeps generated output out of git but never the assets.
      const ignore = read(dir, '.gitignore');
      assert.ok(ignore.includes('export/out/'));
      assert.ok(!/^assets\/$/m.test(ignore));
    });
  }

  test('the BA and tester projects both carry a traceability matrix in csv', async () => {
    for (const templateId of ['doc-ba', 'doc-tester'] as const) {
      const result = await service.createProject(makeRequest(templateId));
      assert.strictEqual(result.success, true, result.error);
      const csv = read(result.path, '05-traceability/rtm.csv');
      assert.strictEqual(headerOf(csv), csvHeader(RTM_COLUMNS));
      // Excel on a BM locale needs the BOM or the header mangles.
      assert.strictEqual(csv.charCodeAt(0), 0xfeff);
    }
  });

  test('the tester project carries the evidence register', async () => {
    const result = await service.createProject(makeRequest('doc-tester'));
    const csv = read(result.path, '04-defects/test-evidence-register.csv');
    assert.strictEqual(headerOf(csv), csvHeader(EVIDENCE_COLUMNS));
  });

  test('rtm.csv headers are byte-identical across role projects', async () => {
    const ba = await service.createProject(makeRequest('doc-ba'));
    const tester = await service.createProject(makeRequest('doc-tester'));
    assert.strictEqual(
      headerOf(read(ba.path, '05-traceability/rtm.csv')),
      headerOf(read(tester.path, '05-traceability/rtm.csv'))
    );
  });

  test('the writer project maps requirements without a duplicate rtm.csv', async () => {
    const result = await service.createProject(makeRequest('doc-writer'));
    assert.ok(exists(result.path, '05-traceability/requirements-mapping.md'));
    assert.ok(!exists(result.path, '05-traceability/rtm.csv'));
  });

  test('every generated document carries front matter with the project version', async () => {
    const result = await service.createProject(makeRequest('doc-ba'));
    const body = read(result.path, '01-business-analysis/brs.md');
    assert.ok(body.startsWith('---'));
    assert.ok(body.includes('doc-id: docproj-BA-BRD-001'));
    assert.ok(body.includes('version: 1.2.3'));
    assert.ok(body.includes('classification: INTERNAL'));
    assert.ok(body.includes('lang: en'));
  });

  // ── KRiSA ────────────────────────────────────────────────────────
  test('KRiSA governance coerces the export choices and warns', async () => {
    const result = await service.createProject(
      makeRequest('doc-ba', {
        governance: 'KRiSA (Government)',
        krisaCompliance: false,
        wordExport: 'None',
      })
    );
    assert.strictEqual(result.success, true, result.error);
    assert.ok(result.warnings && result.warnings.length >= 2, 'coercions must be reported');
    assert.ok(result.warnings!.some((w) => w.includes('compliance matrix')));
    assert.ok(result.warnings!.some((w) => w.includes('Word export')));

    const meta = record(result.path);
    assert.strictEqual(meta.framework, 'KRiSA (Government)');
    assert.strictEqual(meta.classification, 'TERHAD');
    assert.strictEqual(meta.wordExport, 'Both (recommended)');
    assert.ok(exists(result.path, 'export/pandoc.yaml'), 'forced Word export must write the pipeline');
  });

  test('the KRiSA matrix lists only this role artefacts, with unresolved clause refs', async () => {
    for (const templateId of DOC_TEMPLATES) {
      const result = await service.createProject(
        makeRequest(templateId, { governance: 'KRiSA (Government)' })
      );
      const matrix = read(result.path, '00-project-control/krisa-compliance-matrix.md');
      const role = ROLES[templateId] as 'BA' | 'Writer' | 'Tester';
      const expected = krisaArtefactsForRole(role);
      for (const artefact of expected) {
        assert.ok(matrix.includes(artefact.id), `${templateId} matrix missing ${artefact.id}`);
      }
      const otherIds = KRISA_ARTEFACTS.filter((a) => a.owner !== role).map((a) => a.id);
      for (const otherId of otherIds) {
        assert.ok(!matrix.includes(otherId), `${templateId} matrix claims ${otherId}`);
      }
      assert.ok(matrix.includes('TODO — confirm clause'));
    }
  });

  test('KRiSA adds the role-specific artefacts', async () => {
    const writer = await service.createProject(
      makeRequest('doc-writer', { governance: 'KRiSA (Government)' })
    );
    assert.ok(exists(writer.path, '01-design/configuration-management.md'));

    const tester = await service.createProject(
      makeRequest('doc-tester', { governance: 'KRiSA (Government)' })
    );
    assert.ok(exists(tester.path, '06-evidence/test-summary-report.md'));
    assert.ok(
      exists(tester.path, '06-evidence/security-test-report.md'),
      'KRiSA must add the security report'
    );
    assert.ok(tester.warnings!.some((w) => w.includes('security test report')));
  });

  test('KRiSA forces the spreadsheet register for the tester', async () => {
    const result = await service.createProject(
      makeRequest('doc-tester', { governance: 'KRiSA (Government)', xlsxExport: 'None' })
    );
    assert.strictEqual(record(result.path).xlsxExport, 'Registers + summary');
    assert.ok(result.warnings!.some((w) => w.includes('spreadsheet')));
  });

  // ── Toggles ──────────────────────────────────────────────────────
  test('role toggles remove the folders they own', async () => {
    const noProcess = await service.createProject(makeRequest('doc-ba', { includeProcess: false }));
    assert.ok(!exists(noProcess.path, '01-process/process-as-is.md'));

    const noRunbooks = await service.createProject(
      makeRequest('doc-writer', { includeRunbooks: false, includeApiDocs: false })
    );
    assert.ok(!exists(noRunbooks.path, '03-operations/deployment-guide.md'));
    assert.ok(!exists(noRunbooks.path, '04-api/api-reference.md'));

    const noUat = await service.createProject(makeRequest('doc-tester', { includeUat: false }));
    assert.ok(!exists(noUat.path, '03-uat/uat-signoff.md'));
    // The traceability matrix survives an artefact toggle: it is the join.
    assert.ok(exists(noUat.path, '05-traceability/rtm.csv'));
  });

  test('document control Minimal removes the control documents', async () => {
    const result = await service.createProject(makeRequest('doc-ba', { docControl: 'Minimal' }));
    assert.ok(!exists(result.path, '06-change-control/change-request-log.md'));
    assert.ok(!exists(result.path, '00-project-control/document-control.md'));
    assert.ok(!exists(result.path, '00-project-control/document-register.csv'));
  });

  test('Word export None writes no export pipeline', async () => {
    const result = await service.createProject(makeRequest('doc-ba', { wordExport: 'None' }));
    assert.ok(!exists(result.path, 'export/pandoc.yaml'));
    assert.strictEqual(record(result.path).wordExport, 'None');
  });

  test('Bahasa Malaysia documents use BM front matter and BM titles', async () => {
    const result = await service.createProject(
      makeRequest('doc-writer', { docLanguage: 'Bahasa Malaysia' })
    );
    const body = read(result.path, '02-user-docs/user-manual.md');
    assert.ok(body.includes('id-dokumen:'));
    assert.ok(body.includes('tajuk: Manual Pengguna'));
    assert.ok(body.includes('bahasa: ms'));
    assert.strictEqual(record(result.path).language, 'ms');
    assert.ok(read(result.path, 'export/pandoc.yaml').includes('lang: ms'));
  });

  test('the README doc map lists every generated document id', async () => {
    const result = await service.createProject(makeRequest('doc-ba'));
    const readme = read(result.path, 'README.md');
    const meta = record(result.path);
    assert.ok(readme.includes('docproj-BA-BRD-001'));
    assert.ok(readme.includes('Business Analysis'));
    assert.strictEqual(meta.documentCount, (readme.match(/docproj-BA-/g) || []).length);
  });

  test('every role scaffolds an inputs tree with a register and one folder per sourced document', async () => {
    for (const templateId of DOC_TEMPLATES) {
      const result = await service.createProject(makeRequest(templateId));
      assert.ok(exists(result.path, 'inputs/README.md'), `${templateId}: inputs index missing`);
      assert.ok(exists(result.path, 'inputs/source-register.csv'), `${templateId}: register missing`);
      assert.strictEqual(
        headerOf(read(result.path, 'inputs/source-register.csv')),
        csvHeader(INPUT_COLUMNS),
        `${templateId}: input register header drifted from the column contract`
      );

      const meta = record(result.path);
      const folders: string[] = meta.inputs.folders;
      assert.ok(folders.length >= 3, `${templateId}: expected several input folders`);
      assert.ok(
        folders.includes('inputs/_general'),
        `${templateId}: the catch-all folder must always exist`
      );
      for (const folder of folders) {
        assert.ok(
          exists(result.path, `${folder}/README.md`),
          `${templateId}: ${folder} has no README, so git would not track it`
        );
      }

      const index = read(result.path, 'inputs/README.md');
      for (const folder of folders) {
        assert.ok(index.includes(`${folder}/`), `${templateId}: index omits ${folder}`);
      }
      assert.ok(index.includes('LINKED-REQ'), 'the index must explain the requirement link');
    }
  });

  test('derived documents get no input folder, sourced ones do', async () => {
    const result = await service.createProject(makeRequest('doc-ba'));
    assert.ok(exists(result.path, 'inputs/brd'), 'the BRD is written from workshops');
    assert.ok(exists(result.path, 'inputs/frs'), 'the FRS is written from SME interviews');
    assert.ok(!exists(result.path, 'inputs/rtm'), 'the RTM is derived, not sourced');
    assert.ok(!exists(result.path, 'inputs/dct'), 'document control is a register');
  });

  test('each document body points at its own input folder', async () => {
    const result = await service.createProject(makeRequest('doc-tester'));
    const cases = read(result.path, '02-test-cases/test-cases.md');
    assert.ok(cases.includes('## Source inputs'));
    assert.ok(cases.includes('inputs/tcs/'), 'the section must name the folder');

    const rtm = read(result.path, '05-traceability/rtm.md');
    assert.ok(!rtm.includes('## Source inputs'), 'a generated matrix has no source folder');
  });

  test('captureInputs: false writes no inputs tree and records it as disabled', async () => {
    const result = await service.createProject(makeRequest('doc-ba', { captureInputs: false }));
    assert.ok(!exists(result.path, 'inputs'), 'inputs/ must not exist when disabled');
    assert.strictEqual(record(result.path).inputs, null);
    const brs = read(result.path, '01-business-analysis/brs.md');
    assert.ok(!brs.includes('## Source inputs'));
  });

  test('the inputs tree is committed while recordings are ignored', async () => {
    const result = await service.createProject(makeRequest('doc-tester'));
    const gitignore = read(result.path, '.gitignore');
    assert.ok(gitignore.includes('inputs/**/*.mp4'));
    assert.ok(!/^inputs\/$/m.test(gitignore), 'the inputs tree itself must be tracked');
  });
});
