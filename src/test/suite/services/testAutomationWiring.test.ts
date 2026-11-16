import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ProjectCreationService } from '../../../webview/ProjectCreationService';
import { PROJECT_TEMPLATES, ProjectCreationRequest } from '../../../webview-ui/src/components/ProjectCreationWizard/types';
import { TEST_AUTOMATION_OPTIONS } from '../../../shared/testAutomationSuite';
import { cleanTempDir } from '../utils/cleanTempDir';
import { makeScratchDir } from '../utils/scratchDir';

// The service is vscode-free, so this suite runs under plain mocha as well as
// inside the @vscode/test-electron run.
//
// What it pins is the wiring itself: the wizard option group must reach the
// generator (app templates under tests/, the standalone template at the root)
// and the architecture select must change the tree instead of being decorative.

suite('ProjectCreationService — test automation + architecture wiring', () => {
  const service = new ProjectCreationService();
  const scratch: string[] = [];

  function defaultsFor(templateId: string): Record<string, any> {
    const template = PROJECT_TEMPLATES.find(t => t.id === templateId);
    const defaults: Record<string, any> = {};
    template?.options.forEach(o => { defaults[o.id] = o.default; });
    return defaults;
  }

  function makeRequest(overrides: Partial<ProjectCreationRequest> = {}): ProjectCreationRequest {
    const targetPath = makeScratchDir('ado-wiring-test-');
    scratch.push(targetPath);
    return {
      templateId: 'node-ts',
      projectName: 'demo-app',
      projectDescription: 'Test project',
      projectVersion: '0.1.0',
      templateOptions: defaultsFor('node-ts'),
      adoIntegration: false,
      adoWorkItemType: 'Task',
      adoAreaPath: '',
      gitInit: false,
      gitInitialCommit: false,
      gitBranchName: 'main',
      targetPath,
      ...overrides,
    };
  }

  suiteTeardown(() => {
    for (const dir of scratch) {
      try { cleanTempDir(dir); } catch { /* best effort */ }
    }
  });

  const read = (dir: string, rel: string): string =>
    fs.readFileSync(path.join(dir, rel), 'utf8');

  test('the test-automation template writes the suite at the project root', async () => {
    const request = makeRequest({
      templateId: 'test-automation',
      templateOptions: defaultsFor('test-automation'),
    });
    const result = await service.createProject(request);
    assert.ok(result.success, result.error ?? 'creation failed');

    const dir = result.path;
    for (const rel of ['package.json', 'tsconfig.json', 'README.md', 'e2e/playwright.config.ts', 'api/vitest.config.ts']) {
      assert.ok(fs.existsSync(path.join(dir, rel)), `expected ${rel} at the project root`);
    }
    // The suite is the project, not a subfolder of one.
    assert.ok(!fs.existsSync(path.join(dir, 'tests/package.json')), 'must not nest the suite under tests/');

    const ignore = read(dir, '.gitignore');
    assert.ok(ignore.includes('playwright-report/'), '.gitignore must carry the suite ignore lines');
    assert.ok(ignore.includes('node_modules/'), '.gitignore must keep the template lines too');

    assert.ok(
      (result.postCreateSteps ?? []).some(s => /playwright/i.test(s.label) || /playwright/i.test(s.command ?? '')),
      'the browser-download step must be handed back to the wizard'
    );
  });

  test('an app template that enables a suite gets it under tests/', async () => {
    const options = { ...defaultsFor('node-ts'), e2e: true, api: true, perf: false };
    const request = makeRequest({ templateId: 'node-ts', templateOptions: options });
    const result = await service.createProject(request);
    assert.ok(result.success, result.error ?? 'creation failed');

    const dir = result.path;
    assert.ok(fs.existsSync(path.join(dir, 'src/index.ts')), 'the app itself must still be scaffolded');
    assert.ok(fs.existsSync(path.join(dir, 'tests/package.json')), 'the suite belongs under tests/');
    assert.ok(fs.existsSync(path.join(dir, 'tests/e2e/playwright.config.ts')));

    const ignore = read(dir, '.gitignore');
    assert.ok(ignore.includes('test-results/'), 'the app .gitignore must gain the suite lines');
  });

  test('a suite group with every suite off writes nothing', async () => {
    const options = { ...defaultsFor('node-ts'), e2e: false, api: false, perf: false };
    const request = makeRequest({ templateId: 'node-ts', templateOptions: options });
    const result = await service.createProject(request);
    assert.ok(result.success, result.error ?? 'creation failed');

    const dir = result.path;
    assert.ok(!fs.existsSync(path.join(dir, 'tests')), 'no suite means no tests/ tree');
    assert.ok(!read(dir, '.gitignore').includes('playwright-report/'), 'and no stray ignore lines');
  });

  test('microservices on the TypeScript stack produces the cross-stack tree', async () => {
    const request = makeRequest({
      templateId: 'node-ts',
      templateOptions: { ...defaultsFor('node-ts'), architecture: 'microservices', e2e: false, api: false },
    });
    const result = await service.createProject(request);
    assert.ok(result.success, result.error ?? 'creation failed');

    const dir = result.path;
    assert.ok(fs.existsSync(path.join(dir, 'services')), 'microservices must emit services/');
    assert.ok(
      !fs.existsSync(path.join(dir, 'src/index.ts')),
      'and must not also emit the single-project layout'
    );
  });

  test('microservices on the Python stack builds a uv workspace instead of warning', async () => {
    const request = makeRequest({
      templateId: 'python',
      templateOptions: { ...defaultsFor('python'), architecture: 'microservices', e2e: false, api: false },
    });
    const result = await service.createProject(request);
    assert.ok(result.success, result.error ?? 'creation failed');

    const warnings = (result.warnings ?? []).join('\n');
    assert.ok(!/not scaffolded/i.test(warnings), `a Python monorepo writer exists now, got: ${warnings}`);
    const pyproject = fs.readFileSync(path.join(result.path, 'pyproject.toml'), 'utf8');
    assert.ok(/\[tool\.uv\.workspace\]/.test(pyproject), 'the root manifest is a uv workspace');
    assert.ok(fs.existsSync(path.join(result.path, 'services')), 'one folder per service');
    assert.ok(fs.existsSync(path.join(result.path, 'docker-compose.yml')), 'the stack stays containerized');
    assert.ok(!fs.existsSync(path.join(result.path, 'package.json')), 'and is not a Node workspace');
  });

  test('microservices on a stack without a writer still warns instead of pretending', async () => {
    const request = makeRequest({
      templateId: 'nextjs',
      templateOptions: { ...defaultsFor('nextjs'), architecture: 'microservices', e2e: false, api: false },
    });
    const result = await service.createProject(request);
    assert.ok(result.success, result.error ?? 'creation failed');

    const warnings = (result.warnings ?? []).join('\n');
    assert.ok(/not scaffolded/i.test(warnings), `expected a microservices warning, got: ${warnings}`);
    assert.ok(/nextjs/.test(warnings), 'the warning must name the template');
    assert.ok(!fs.existsSync(path.join(result.path, 'services')), 'no monorepo tree is faked');
  });

  test('the default architecture leaves the classic tree alone', async () => {
    const request = makeRequest({
      templateId: 'node-ts',
      templateOptions: { ...defaultsFor('node-ts'), e2e: false, api: false },
    });
    const result = await service.createProject(request);
    assert.ok(result.success, result.error ?? 'creation failed');
    assert.ok(fs.existsSync(path.join(result.path, 'src/index.ts')));
    assert.ok(!fs.existsSync(path.join(result.path, 'services')), 'layered must not emit services/');
    assert.ok(
      !(result.warnings ?? []).some(w => /microservices/i.test(w)),
      'the default must not warn'
    );
  });

  test('a template that does not offer the group never gets a suite', async () => {
    // The leak this guards: `isSuiteEnabled` reads an absent option as enabled,
    // so without a catalogue gate every template would gain a tests/ tree — and
    // the templates without the group have their trees pinned by fixtures.
    const request = makeRequest({
      templateId: 'empty',
      templateOptions: defaultsFor('empty'),
    });
    const result = await service.createProject(request);
    assert.ok(result.success, result.error ?? 'creation failed');
    assert.ok(!fs.existsSync(path.join(result.path, 'tests')), 'no group, no tests/ tree');
    assert.ok(
      !(result.postCreateSteps ?? []).some(s => /playwright/i.test(s.command ?? '')),
      'and no post-create step it never asked for'
    );
  });

  test('the group ids the template offers are the ids the generator understands', () => {
    // Guards against the catalogue and the generator drifting apart: every id
    // in the shared metadata must be a key the generator reads.
    const ids = TEST_AUTOMATION_OPTIONS.map(o => o.id);
    const template = PROJECT_TEMPLATES.find(t => t.id === 'test-automation')!;
    assert.deepStrictEqual(template.options.map(o => o.id), ids);
  });
});
