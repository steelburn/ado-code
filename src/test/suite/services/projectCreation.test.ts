import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ProjectCreationService } from '../../../webview/ProjectCreationService';
import { PROJECT_TEMPLATES, ProjectCreationRequest } from '../../../webview-ui/src/components/ProjectCreationWizard/types';
import { cleanTempDir } from '../utils/cleanTempDir';
import { makeScratchDir } from '../utils/scratchDir';

// ProjectCreationService is vscode-free — this suite runs under plain mocha
// (npx mocha --ui tdd out/test/suite/services/projectCreation.test.js) AND
// inside the full @vscode/test-electron suite.

suite('ProjectCreationService', () => {
  const service = new ProjectCreationService();
  const GIT_ENV_KEYS = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'] as const;
  const savedEnv: Record<string, string | undefined> = {};

  /** Default option values for a template — mirrors the wizard's defaultsFor(). */
  function defaultsFor(templateId: string): Record<string, any> {
    const template = PROJECT_TEMPLATES.find(t => t.id === templateId);
    const defaults: Record<string, any> = {};
    template?.options.forEach(o => { defaults[o.id] = o.default; });
    return defaults;
  }

  function makeRequest(overrides: Partial<ProjectCreationRequest> = {}): ProjectCreationRequest {
    return {
      templateId: 'node-ts',
      projectName: 'demo-app',
      projectDescription: 'Test project',
      projectVersion: '0.1.0',
      templateOptions: {},
      adoIntegration: false,
      adoWorkItemType: 'Task',
      adoAreaPath: '',
      gitInit: true,
      gitInitialCommit: true,
      gitBranchName: 'main',
      targetPath: makeScratchDir('ado-project-test-'),
      ...overrides,
    };
  }

  function git(dir: string, args: string[]): string {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  }

  function gitOk(dir: string, args: string[]): boolean {
    try {
      execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'] });
      return true;
    } catch {
      return false;
    }
  }

  suiteSetup(() => {
    for (const key of GIT_ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    // Deterministic commits regardless of the machine's git identity config.
    process.env.GIT_AUTHOR_NAME = 'ADO Code Test';
    process.env.GIT_AUTHOR_EMAIL = 'ado-code-test@example.com';
    process.env.GIT_COMMITTER_NAME = 'ADO Code Test';
    process.env.GIT_COMMITTER_EMAIL = 'ado-code-test@example.com';
  });

  suiteTeardown(() => {
    for (const key of GIT_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key]!;
    }
  });

  teardown(() => {
    // clean any leftover temp dirs from this run using cleanTempDir helper
    for (const entry of fs.readdirSync(os.tmpdir())) {
      if (entry.startsWith('ado-project-test-') || entry.startsWith('ado-blank-dir-')) {
        cleanTempDir(path.join(os.tmpdir(), entry));
      }
    }
  });

  // ── All project types ────────────────────────────────────────────

  // One entry per PROJECT_TEMPLATES id — "test all new project types".
  const EXPECTED_FILES: Record<string, string[]> = {
    'node-ts': ['package.json', 'tsconfig.json', 'src/index.ts', '.gitignore'],
    'node-js': ['package.json', 'index.js', '.gitignore'],
    python: ['pyproject.toml', 'demo_app.py', 'tests/test_demo_app.py', '.gitignore'],
    'php-laravel': ['composer.json', 'artisan', 'bootstrap/app.php', 'routes/web.php', '.gitignore'],
    php: ['composer.json', 'src/index.php', 'phpunit.xml', '.gitignore'],
    'dotnet-webapi': ['demo-app.csproj', 'demo-app.sln', 'Program.cs', 'appsettings.json', 'Controllers/WeatherForecastController.cs', '.gitignore'],
    'dotnet-console': ['demo-app.csproj', 'Program.cs', '.gitignore'],
    'react-ts': ['package.json', 'index.html', 'vite.config.ts', 'tsconfig.json', 'src/main.tsx', 'src/App.tsx', '.gitignore'],
    nextjs: ['package.json', 'next.config.js', 'tsconfig.json', 'src/app/layout.tsx', 'src/app/page.tsx', '.gitignore'],
    'react-native': ['package.json', 'app.json', 'app/_layout.tsx', 'app/index.tsx', 'src/screens/HomeScreen.tsx', 'tsconfig.json', '.gitignore', 'README.md'],
    flutter: ['pubspec.yaml', 'analysis_options.yaml', 'lib/main.dart', 'lib/app.dart', 'lib/core/api_client.dart', 'lib/state/counter_provider.dart', 'test/widget_test.dart', '.gitignore'],
    'dotnet-maui': ['DemoApp.csproj', 'App.xaml', 'AppShell.xaml', 'MainPage.xaml', 'MauiProgram.cs', 'ViewModels/MainViewModel.cs', 'Platforms/Android/MainActivity.cs', '.gitignore'],
    'monorepo-microservices': ['package.json', 'tsconfig.base.json', 'ARCHITECTURE.md', 'docker-compose.yml', 'services/gateway/src/index.ts', 'services/users/Dockerfile', 'packages/shared/src/index.ts', '.github/workflows/ci.yml', '.gitignore'],
    empty: ['README.md', '.gitignore', 'LICENSE'],
    'doc-ba': ['README.md', '.gitignore', '00-project-control/project-charter.md', '01-business-analysis/brs.md', '05-traceability/rtm.md', '05-traceability/rtm.csv', '.ado-code/documentation.json'],
    'doc-writer': ['README.md', '.gitignore', '01-design/srs.md', '02-user-docs/user-manual.md', 'export/pandoc.yaml', '.ado-code/documentation.json'],
    'doc-tester': ['README.md', '.gitignore', '01-test-planning/test-plan.md', '02-test-cases/test-cases.md', '04-defects/test-evidence-register.csv', '05-traceability/rtm.csv', '.ado-code/documentation.json'],
  };

  for (const template of PROJECT_TEMPLATES) {
    test(`scaffolds "${template.id}" with all default options`, async () => {
      const request = makeRequest({
        templateId: template.id,
        templateOptions: defaultsFor(template.id),
      });
      const result = await service.createProject(request);

      assert.strictEqual(result.success, true, result.error);
      // A blank target folder IS the project base (in-place scaffold).
      assert.strictEqual(result.path, request.targetPath);

      const projectDir = result.path!;
      for (const file of EXPECTED_FILES[template.id]) {
        assert.ok(fs.existsSync(path.join(projectDir, file)), `missing ${file} for ${template.id}`);
      }

      // Default git behaviour: repo initialized, initial commit made, branch main.
      assert.ok(fs.existsSync(path.join(projectDir, '.git')), `${template.id}: expected a git repo`);
      assert.strictEqual(git(projectDir, ['symbolic-ref', '--short', 'HEAD']), 'main');
      assert.ok(gitOk(projectDir, ['log', '--oneline']), `${template.id}: expected an initial commit`);
    });
  }

  // ── Documentation templates: result metadata ─────────────────────
  //
  // The wizard toast reads `warnings`, and the export bar is switched on by
  // `templateId` + `documents` riding on `projectWizardCreated` — so both must
  // actually come back from createProject, not merely be typed on the result.

  for (const docTemplateId of ['doc-ba', 'doc-writer', 'doc-tester']) {
    test(`"${docTemplateId}" reports the documents it wrote plus a warnings array`, async () => {
      const request = makeRequest({
        templateId: docTemplateId,
        templateOptions: defaultsFor(docTemplateId),
      });
      const result = await service.createProject(request);
      assert.strictEqual(result.success, true, result.error);

      assert.ok(Array.isArray(result.documents), 'expected a documents array');
      assert.ok((result.documents?.length ?? 0) > 0, 'expected the written documents to be listed');
      assert.ok(Array.isArray(result.warnings), 'warnings must be an array even when empty');

      for (const doc of result.documents!) {
        assert.ok(!path.isAbsolute(doc), `expected a project-relative path, got ${doc}`);
        assert.ok(!doc.includes('\\'), `expected forward slashes, got ${doc}`);
        assert.ok(fs.existsSync(path.join(result.path!, doc)), `listed document missing on disk: ${doc}`);
      }

      // Every role writes its own README; registers are CSV, generated from the
      // columns contract, and are deliberately not documents.
      assert.ok(result.documents!.some((d) => d.endsWith('README.md')), 'the project README is a document');
      assert.ok(!result.documents!.some((d) => d.endsWith('.csv')), 'CSV registers are not documents');
    });
  }

  test('a KRiSA documentation project reports its coercions as warnings', async () => {
    const request = makeRequest({
      templateId: 'doc-tester',
      templateOptions: {
        ...defaultsFor('doc-tester'),
        governance: 'KRiSA (Government)',
        includeSecurity: false,
      },
    });
    const result = await service.createProject(request);

    assert.strictEqual(result.success, true, result.error);
    assert.ok((result.warnings?.length ?? 0) > 0, 'expected the KRiSA coercions to be reported');
    assert.ok(
      result.warnings!.some((w) => /security/i.test(w)),
      `expected the security-report coercion to be named, got: ${result.warnings!.join(' | ')}`
    );
  });
  // ── Template option behaviour ────────────────────────────────────

  test('node-ts honors eslint/prettier/jest/docker options', async () => {
    const request = makeRequest({
      templateOptions: { eslint: true, prettier: true, jest: true, docker: true },
    });
    const result = await service.createProject(request);
    assert.strictEqual(result.success, true, result.error);
    const dir = result.path!;

    assert.ok(fs.existsSync(path.join(dir, '.eslintrc.json')));
    assert.ok(fs.existsSync(path.join(dir, '.prettierrc')));
    assert.ok(fs.existsSync(path.join(dir, 'Dockerfile')));
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.scripts.test, 'jest');
    // No lockfile is generated, so the Dockerfile must use `npm install`
    // (npm ci would fail).
    assert.ok(fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf8').includes('RUN npm install'));
  });

  test('node-ts without options writes no optional files', async () => {
    const request = makeRequest({
      templateOptions: { eslint: false, prettier: false, jest: false, docker: false },
    });
    const result = await service.createProject(request);
    assert.strictEqual(result.success, true, result.error);
    const dir = result.path!;
    assert.ok(!fs.existsSync(path.join(dir, '.eslintrc.json')));
    assert.ok(!fs.existsSync(path.join(dir, '.prettierrc')));
    assert.ok(!fs.existsSync(path.join(dir, 'Dockerfile')));
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.notStrictEqual(pkg.scripts.test, 'jest');
  });

  test('empty template honors license/readme/gitignore defaults', async () => {
    const request = makeRequest({
      templateId: 'empty',
      templateOptions: { readme: true, gitignore: true, license: 'MIT' },
    });
    const result = await service.createProject(request);
    assert.strictEqual(result.success, true, result.error);
    const dir = result.path!;
    assert.ok(fs.readFileSync(path.join(dir, 'README.md'), 'utf8').includes('# demo-app'));
    assert.ok(fs.readFileSync(path.join(dir, 'LICENSE'), 'utf8').includes('MIT License'));
    // the "empty" gitignore is non-empty so the option actually writes a file
    assert.ok(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').length > 0);
  });

  test('nextjs writes prisma dep + schema and tailwind globals import', async () => {
    const request = makeRequest({
      templateId: 'nextjs',
      templateOptions: { tailwind: true, prisma: true, auth: false },
    });
    const result = await service.createProject(request);
    assert.strictEqual(result.success, true, result.error);
    const dir = result.path!;
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.ok(pkg.devDependencies.prisma, 'prisma devDependency missing from package.json');
    assert.ok(fs.existsSync(path.join(dir, 'prisma', 'schema.prisma')));
    assert.ok(fs.existsSync(path.join(dir, 'src', 'app', 'globals.css')));
    assert.ok(
      fs.readFileSync(path.join(dir, 'src', 'app', 'layout.tsx'), 'utf8').includes("import './globals.css'")
    );
  });

  test('php-laravel composer PSR-4 keys end with a single backslash', async () => {
    const request = makeRequest({
      templateId: 'php-laravel',
      templateOptions: { sail: false, pest: false },
    });
    const result = await service.createProject(request);
    assert.strictEqual(result.success, true, result.error);
    const dir = result.path!;
    const composer = JSON.parse(fs.readFileSync(path.join(dir, 'composer.json'), 'utf8'));
    // PSR-4 keys must end with a single backslash (double-escaped in JSON)
    assert.deepStrictEqual(composer.autoload['psr-4'], {
      'App\\': 'app/',
      'Database\\Factories\\': 'database/factories/',
      'Database\\Seeders\\': 'database/seeders/',
    });
    assert.deepStrictEqual(composer['autoload-dev']['psr-4'], { 'Tests\\': 'tests/' });
    // artisan must reference real PHP namespaces (single backslashes)
    const artisan = fs.readFileSync(path.join(dir, 'artisan'), 'utf8');
    assert.ok(artisan.includes('use Symfony\\Component\\Console\\Input\\ArgvInput;'));
  });

  test('dotnet-webapi sln carries a valid project GUID', async () => {
    const request = makeRequest({ templateId: 'dotnet-webapi' });
    const result = await service.createProject(request);
    assert.strictEqual(result.success, true, result.error);
    const sln = fs.readFileSync(path.join(result.path!, 'demo-app.sln'), 'utf8');
    assert.ok(!sln.includes('GUID-HERE'), 'placeholder GUID still present');
    assert.match(sln, /\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}/);
  });

  // ── Git behaviour ────────────────────────────────────────────────

  test('honors a custom git branch name', async () => {
    const request = makeRequest({ gitBranchName: 'develop' });
    const result = await service.createProject(request);
    assert.strictEqual(result.success, true, result.error);
    assert.strictEqual(git(result.path!, ['symbolic-ref', '--short', 'HEAD']), 'develop');
  });

  test('gitInit:false creates no repository', async () => {
    const request = makeRequest({ gitInit: false, gitInitialCommit: false });
    const result = await service.createProject(request);
    assert.strictEqual(result.success, true, result.error);
    assert.ok(!fs.existsSync(path.join(result.path!, '.git')));
  });

  test('gitInit without initial commit leaves an empty repo on the right branch', async () => {
    const request = makeRequest({ gitInitialCommit: false });
    const result = await service.createProject(request);
    assert.strictEqual(result.success, true, result.error);
    assert.ok(fs.existsSync(path.join(result.path!, '.git')));
    assert.strictEqual(git(result.path!, ['symbolic-ref', '--short', 'HEAD']), 'main');
    assert.ok(!gitOk(result.path!, ['rev-parse', '--verify', 'HEAD']), 'expected no commits');
  });

  // ── Validation & errors ──────────────────────────────────────────

  test('rejects an empty project name', async () => {
    const result = await service.createProject(makeRequest({ projectName: '  ' }));
    assert.strictEqual(result.success, false);
    assert.match(result.error!, /Project name is required/);
  });

  test('rejects path-traversing project names', async () => {
    const result = await service.createProject(makeRequest({ projectName: '../evil' }));
    assert.strictEqual(result.success, false);
    assert.match(result.error!, /Invalid project name/);
    assert.ok(!fs.existsSync(path.join(os.tmpdir(), 'evil')));
  });

  test('rejects an existing project directory', async () => {
    const request = makeRequest();
    fs.mkdirSync(path.join(request.targetPath, 'demo-app'), { recursive: true });
    const result = await service.createProject(request);
    assert.strictEqual(result.success, false);
    assert.match(result.error!, /already exists/);
  });

  test('rejects an unknown template', async () => {
    const result = await service.createProject(makeRequest({ templateId: 'cobol' }));
    assert.strictEqual(result.success, false);
    assert.match(result.error!, /Unknown template/);
  });

  test('rejects an empty targetPath', async () => {
    const result = await service.createProject(makeRequest({ targetPath: '' }));
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'No target path specified');
  });

  // ── Base folder: blank target vs folder with content ─────────────

  test('scaffolds in place when the target folder is blank', async () => {
    // Simulates: user opens a BLANK folder, wizard resolves targetPath = that folder.
    const blankDir = makeScratchDir('ado-blank-dir-');
    const request = makeRequest({ targetPath: blankDir });
    const result = await service.createProject(request);
    assert.strictEqual(result.success, true, result.error);
    assert.strictEqual(result.path, blankDir, 'blank target folder is the project base');
    assert.ok(fs.existsSync(path.join(blankDir, 'package.json')));
    assert.ok(!fs.existsSync(path.join(blankDir, 'demo-app')), 'no nested project directory');
    assert.ok(gitOk(blankDir, ['log', '--oneline']), 'blank-dir project should be committed');
  });

  test('still treats a folder as blank when it only holds benign metadata', async () => {
    const blankDir = makeScratchDir('ado-blank-dir-');
    // Editor/OS/extension artefacts are not project content: this extension's
    // own .ado-code metadata, a .vscode settings file, node_modules.
    fs.mkdirSync(path.join(blankDir, '.ado-code', 'memory'), { recursive: true });
    fs.writeFileSync(path.join(blankDir, '.ado-code', 'memory', 'keep.md'), 'keep me');
    fs.mkdirSync(path.join(blankDir, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(blankDir, '.vscode', 'settings.json'), '{}');
    fs.mkdirSync(path.join(blankDir, 'node_modules'), { recursive: true });

    const result = await service.createProject(makeRequest({ targetPath: blankDir }));
    assert.strictEqual(result.success, true, result.error);
    assert.strictEqual(result.path, blankDir);
    assert.ok(fs.existsSync(path.join(blankDir, 'package.json')));
    // …and the metadata is left alone.
    assert.strictEqual(
      fs.readFileSync(path.join(blankDir, '.ado-code', 'memory', 'keep.md'), 'utf8'),
      'keep me'
    );
  });

  test('scaffolds in place into a folder that is already a fresh git repo', async () => {
    const dir = makeScratchDir('ado-blank-dir-');
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
    const result = await service.createProject(makeRequest({ targetPath: dir }));
    assert.strictEqual(result.success, true, result.error);
    assert.strictEqual(result.path, dir);
    assert.ok(gitOk(dir, ['log', '--oneline']), 'in-place project should be committed');
  });

  test('nests a project directory when the target folder already has content', async () => {
    const target = makeScratchDir('ado-blank-dir-');
    fs.writeFileSync(path.join(target, 'notes.txt'), 'not a project');
    const result = await service.createProject(makeRequest({ targetPath: target }));
    assert.strictEqual(result.success, true, result.error);
    assert.strictEqual(result.path, path.join(target, 'demo-app'));
    assert.ok(fs.existsSync(path.join(target, 'demo-app', 'package.json')));
    assert.strictEqual(fs.readFileSync(path.join(target, 'notes.txt'), 'utf8'), 'not a project');
  });

  test('nests instead of clobbering a file a template would write', async () => {
    // Every template writes .gitignore, so a folder holding one is NOT blank.
    const target = makeScratchDir('ado-blank-dir-');
    fs.writeFileSync(path.join(target, '.gitignore'), '# mine');
    const result = await service.createProject(makeRequest({ targetPath: target }));
    assert.strictEqual(result.success, true, result.error);
    assert.strictEqual(result.path, path.join(target, 'demo-app'));
    assert.strictEqual(fs.readFileSync(path.join(target, '.gitignore'), 'utf8'), '# mine');
  });

  // ── Mobile templates ─────────────────────────────────────────────

  test('react-native bare CLI honours the expo and navigation options', async () => {
    const result = await service.createProject(makeRequest({
      templateId: 'react-native',
      templateOptions: { ...defaultsFor('react-native'), expo: false, navigation: 'expo-router', stateManagement: 'none', testing: false, eslint: false },
    }));
    assert.ok(result.success, result.error);
    const dir = result.path!;
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.main, 'index.js');
    assert.ok(fs.existsSync(path.join(dir, 'index.js')), 'bare React Native needs an index.js entry');
    assert.strictEqual(pkg.scripts.test, undefined);
    // expo-router is an Expo-only option — a bare project must not depend on it.
    assert.strictEqual(pkg.dependencies['expo-router'], undefined);
    assert.ok(!fs.existsSync(path.join(dir, 'app')), 'bare project must not emit Expo Router routes');
    assert.ok((result.warnings || []).some((warning) => warning.includes('Bare React Native')));
  });

  test('react-native Expo project wires expo-router and a zustand store', async () => {
    const result = await service.createProject(makeRequest({
      templateId: 'react-native',
      templateOptions: defaultsFor('react-native'),
    }));
    assert.ok(result.success, result.error);
    const dir = result.path!;
    const appConfig = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8'));
    assert.deepStrictEqual(appConfig.expo.plugins, ['expo-router']);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.main, 'expo-router/entry');
    assert.ok(pkg.dependencies.zustand);
    assert.ok(fs.existsSync(path.join(dir, 'src/store/useAppStore.ts')));
  });

  test('flutter pubspec reflects the chosen state management and HTTP client', async () => {
    const result = await service.createProject(makeRequest({
      templateId: 'flutter',
      templateOptions: { ...defaultsFor('flutter'), stateManagement: 'bloc', httpClient: 'http' },
    }));
    assert.ok(result.success, result.error);
    const dir = result.path!;
    const pubspec = fs.readFileSync(path.join(dir, 'pubspec.yaml'), 'utf8');
    assert.ok(pubspec.includes('flutter_bloc'), 'bloc must be a dependency');
    assert.ok(!pubspec.includes('flutter_riverpod'), 'riverpod must not leak in');
    assert.ok(pubspec.includes('http: ^'), 'http client dependency');
    const screen = fs.readFileSync(path.join(dir, 'lib/features/home/presentation/home_screen.dart'), 'utf8');
    assert.ok(screen.includes('BlocBuilder<CounterCubit, int>'));
    // Platform runners are SDK-generated — the wizard must surface the command
    // as a "Next Steps" step, not a warning toast that scrolls away.
    const steps = result.postCreateSteps || [];
    const runnerStep = steps.find((step) => (step.command || '').includes('flutter create .'));
    assert.ok(runnerStep, 'flutter create . missing from postCreateSteps');
    assert.ok(runnerStep.command!.startsWith('flutter create . --platforms='));
    assert.ok(!(result.warnings || []).some((warning) => warning.includes('flutter create')));
  });

  test('only Flutter reports post-create steps — the wizard closes silently otherwise', async () => {
    const flutter = await service.createProject(
      makeRequest({ templateId: 'flutter', templateOptions: defaultsFor('flutter') })
    );
    assert.ok(flutter.success, flutter.error);
    const steps = flutter.postCreateSteps || [];
    assert.strictEqual(steps.length, 1);
    assert.strictEqual(steps[0].label, 'Generate the native runners');
    assert.ok(steps[0].detail && steps[0].detail.includes('SDK'));

    const plain = await service.createProject(
      makeRequest({ templateId: 'react-native', templateOptions: defaultsFor('react-native') })
    );
    assert.ok(plain.success, plain.error);
    assert.deepStrictEqual(plain.postCreateSteps, []);
  });

  test('dotnet-maui targets only the selected platforms', async () => {
    const result = await service.createProject(makeRequest({
      templateId: 'dotnet-maui',
      templateOptions: { ...defaultsFor('dotnet-maui'), ios: false, windows: true, mvvm: false },
    }));
    assert.ok(result.success, result.error);
    const dir = result.path!;
    const csproj = fs.readFileSync(path.join(dir, 'DemoApp.csproj'), 'utf8');
    assert.ok(csproj.includes('net8.0-android'));
    assert.ok(!csproj.includes('net8.0-ios'), 'iOS target was disabled');
    assert.ok(csproj.includes('net8.0-windows'));
    assert.ok(!csproj.includes('CommunityToolkit.Mvvm'));
    assert.ok(!fs.existsSync(path.join(dir, 'ViewModels/MainViewModel.cs')));
    assert.ok(fs.existsSync(path.join(dir, 'Platforms/Windows/App.xaml')));
  });

  // ── Monorepo / microservices ─────────────────────────────────────

  test('monorepo-microservices creates one service per name, with gateway routing', async () => {
    const result = await service.createProject(makeRequest({
      templateId: 'monorepo-microservices',
      templateOptions: { ...defaultsFor('monorepo-microservices'), services: 'gateway, users, billing', docker: false, ci: false },
    }));
    assert.ok(result.success, result.error);
    const dir = result.path!;
    for (const name of ['gateway', 'users', 'billing']) {
      assert.ok(fs.existsSync(path.join(dir, 'services', name, 'src', 'index.ts')), `missing service ${name}`);
    }
    const gateway = fs.readFileSync(path.join(dir, 'services/gateway/src/index.ts'), 'utf8');
    assert.ok(gateway.includes("'/users'"), 'gateway must route /users');
    assert.ok(gateway.includes("'/billing'"), 'gateway must route /billing');
    // Deterministic ports: gateway 4000, then one port per domain service.
    assert.ok(gateway.includes('http://localhost:4001'));
    assert.ok(gateway.includes('http://localhost:4002'));
    assert.ok(!fs.existsSync(path.join(dir, 'docker-compose.yml')), 'docker option was disabled');
  });

  test('monorepo-microservices sanitises service names (no path traversal)', async () => {
    const result = await service.createProject(makeRequest({
      templateId: 'monorepo-microservices',
      templateOptions: { ...defaultsFor('monorepo-microservices'), services: 'api, ../escape, api', docker: false, ci: false },
    }));
    assert.ok(result.success, result.error);
    const dir = result.path!;
    const services = fs.readdirSync(path.join(dir, 'services')).sort();
    assert.deepStrictEqual(services, ['api', 'escape']);
    assert.ok(!fs.existsSync(path.join(dir, '..', 'escape')), 'must never write outside the project');
  });

  test('monorepo-microservices honours workspace tooling, broker and deployment options', async () => {
    const result = await service.createProject(makeRequest({
      templateId: 'monorepo-microservices',
      templateOptions: { ...defaultsFor('monorepo-microservices'), workspaceTool: 'pnpm', messageBroker: 'kafka', k8s: true },
    }));
    assert.ok(result.success, result.error);
    const dir = result.path!;
    assert.ok(fs.existsSync(path.join(dir, 'pnpm-workspace.yaml')));
    const rootPkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.strictEqual(rootPkg.workspaces, undefined, 'pnpm uses pnpm-workspace.yaml, not a workspaces field');
    assert.strictEqual(rootPkg.packageManager, 'pnpm@9.6.0');
    const compose = fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8');
    assert.ok(compose.includes('bitnami/kafka'), 'selected broker must be in the compose stack');
    assert.ok(fs.existsSync(path.join(dir, 'deploy/k8s/gateway.yaml')), 'k8s manifests per service');
    const shared = fs.readFileSync(path.join(dir, 'packages/shared/src/broker.ts'), 'utf8');
    assert.ok(shared.includes('localhost:9092'), 'broker URL must match the selection');
  });
});
