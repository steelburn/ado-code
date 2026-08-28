import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ProjectCreationService } from '../../../webview/ProjectCreationService';
import { PROJECT_TEMPLATES, ProjectCreationRequest } from '../../../webview-ui/src/components/ProjectCreationWizard/types';

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
      targetPath: fs.mkdtempSync(path.join(os.tmpdir(), 'ado-project-test-')),
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
    // clean any leftover temp dirs from this run
    for (const entry of fs.readdirSync(os.tmpdir())) {
      if (entry.startsWith('ado-project-test-') || entry.startsWith('ado-blank-dir-')) {
        fs.rmSync(path.join(os.tmpdir(), entry), { recursive: true, force: true });
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
    empty: ['README.md', '.gitignore', 'LICENSE'],
  };

  for (const template of PROJECT_TEMPLATES) {
    test(`scaffolds "${template.id}" with all default options`, async () => {
      const request = makeRequest({
        templateId: template.id,
        templateOptions: defaultsFor(template.id),
      });
      const result = await service.createProject(request);

      assert.strictEqual(result.success, true, result.error);
      assert.strictEqual(result.path, path.join(request.targetPath, 'demo-app'));

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

  test('creates a new project inside an existing blank directory (the blank-dir flow)', async () => {
    // Simulates: user opens a BLANK folder, wizard resolves targetPath = that folder.
    const blankDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-blank-dir-'));
    const request = makeRequest({ targetPath: blankDir });
    const result = await service.createProject(request);
    assert.strictEqual(result.success, true, result.error);
    assert.strictEqual(result.path, path.join(blankDir, 'demo-app'));
    assert.ok(fs.existsSync(path.join(blankDir, 'demo-app', 'package.json')));
    assert.ok(gitOk(result.path!, ['log', '--oneline']), 'blank-dir project should be committed');
  });
});
