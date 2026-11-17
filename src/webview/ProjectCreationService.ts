import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { BASE_IMAGES, CURL_INSTALL_LINES, hardeningLines } from '../shared/containerHardening';
import { PostCreateStep, ProjectCreationRequest, PROJECT_TEMPLATES } from '../webview-ui/src/components/ProjectCreationWizard/types';
import { DocProjectSpec, DOC_PROJECT_SPECS } from '../shared/documentation/docTemplates';
import { scaffoldDocumentationProject } from '../shared/documentation/scaffoldDocs';
import { ScaffoldContext, resolveContainerization } from '../shared/scaffoldContext';
import { GitignoreLabel, gitignoreContent, gitignoreLabelForStack } from '../shared/gitignoreTemplates';
import { resolveArchitecture } from '../shared/architectureStyles';
import {
  MONOREPO_STACKS,
  MonorepoStackId,
  MonorepoTreePlan,
  monorepoStackForTemplate,
  planMonorepoTree,
  resolveMonorepoStack,
} from '../shared/monorepoStacks';
import {
  planCiWorkflow,
  planDatabaseOverlay,
  planK8sManifests,
  planK8sReadme,
} from '../shared/deliveryArtifacts';
import {
  COMPOSE_DATABASE_PATH,
  EVENT_SCHEMA_VALIDATOR,
  EVENT_SCHEMA_VALIDATOR_PATH,
} from '../shared/deliveryFiles';
import {
  PROJECT_MARKER_FILE,
  ProjectMarker,
  ServiceKind,
  appendArchitectureService,
  appendCiMatrixService,
  appendComposeService,
  appendEnvKeys,
  appendReadmeServiceRow,
  asWorkerComposeBlock,
  composeServiceNames,
  composeServicePorts,
  extractComposeServiceBlock,
  normalizeServiceKind,
  parseProjectMarker,
  serializeProjectMarker,
  serviceNameError,
  serviceSupportsWorker,
  workerEntrypointFiles,
} from '../shared/serviceScaffold';
import {
  API_PREFIX,
  CONTRACTS_DIR,
  defaultEventsFor,
  eventKeyFor,
  planContractFiles,
  resourceNameFor,
} from '../shared/contractArtifacts';
import {
  planResilienceFiles,
  resilienceArchitectureRows,
  sharedResilienceBarrelLines,
} from '../shared/resilienceArtifacts';
import {
  OBSERVABILITY_PATHS,
  planObservabilityFiles,
  sharedObservabilityBarrelLines,
} from '../shared/observabilityArtifacts';
import type { ServiceContract } from '../shared/contractArtifacts';
import { planContainerFiles, supportsContainerization } from '../shared/containerization';
import {
  isSuiteEnabled,
  scaffoldTestAutomationSuite,
  TestAutomationOptions,
} from '../shared/testAutomationSuite';

/**
 * The values the three monorepo writers share.
 *
 * Derived once per request so a writer cannot invent its own ports, workspace
 * tooling or script names: ports feed the gateway routes, the Dockerfiles, the
 * compose file and the README, and a mismatch there stays invisible until
 * `docker compose up` fails. The phase-2 golden tree pins every value.
 */
interface MonorepoPlan {
  name: string;
  version: string;
  description: string;
  /** npm scope for package names, e.g. `demo-app`. */
  scope: string;
  /** Workspace tool: npm / pnpm / yarn / turborepo / nx. */
  tool: string;
  /** Every service, gateway first. */
  services: string[];
  /** The `gateway` service when one was requested, else ''. */
  gateway: string;
  domainServices: string[];
  withShared: boolean;
  broker: string;
  k8s: boolean;
  tooling: boolean;
  isPnpm: boolean;
  /** npm/yarn carry a `workspaces` field; pnpm uses pnpm-workspace.yaml. */
  useWorkspacesField: boolean;
  buildScript: string;
  devScript: string;
  testScript: string;
  installCommand: string;
  sharedName: string;
  brokerUrl: string;
  portOf: (service: string) => number;
  envVar: (service: string) => string;
}

/**
 * Scaffolds new projects from wizard requests. Deliberately vscode-free so it
 * runs under plain mocha (fast tests) — the host (ChatViewProvider) resolves
 * the targetPath before calling createProject.
 */
export class ProjectCreationService {
  /**
   * Create a new project based on the wizard request.
   * Handles directory creation, template scaffolding, git init, and initial commit.
   * A blank target folder is used as the project base itself ("Create New
   * Project here"); only a target holding real content gets a nested
   * <projectName> directory.
   */
  async createProject(
    request: ProjectCreationRequest
  ): Promise<{
    success: boolean;
    path: string;
    error?: string;
    warnings?: string[];
    /**
     * Commands the user still has to run after scaffolding (Flutter's native
     * runners). The wizard renders them as its final "Next Steps" step.
     */
    postCreateSteps?: PostCreateStep[];
    /** Project-relative paths of the documents written (documentation projects). */
    documents?: string[];
  }> {
    try {
      // Guard against empty targetPath (webview sends '' expecting host resolution)
      if (!request.targetPath) {
        return {
          success: false,
          path: '',
          error: 'No target path specified',
        };
      }

      // Reject empty / path-traversing project names before path.join
      const projectName = (request.projectName || '').trim();
      if (!projectName) {
        return { success: false, path: '', error: 'Project name is required' };
      }
      if (/[/\\]/.test(projectName) || projectName === '.' || projectName === '..') {
        return {
          success: false,
          path: '',
          error: `Invalid project name "${request.projectName}" (must be a plain folder name)`,
        };
      }

      const baseDir = request.targetPath;

      // Ensure target path exists
      if (!fs.existsSync(baseDir)) {
        fs.mkdirSync(baseDir, { recursive: true });
      }

      // A blank target folder — a fresh folder opened for "Create New Project
      // here", possibly holding only editor/OS/extension metadata — IS the
      // project. Scaffold into it directly instead of nesting a second
      // <projectName> directory inside it.
      const scaffoldInPlace = this.isBlankTargetDir(baseDir);
      const projectDir = scaffoldInPlace ? baseDir : path.join(baseDir, projectName);

      // In-place mode reuses baseDir by design, so only the nested flow can
      // collide with an existing directory.
      if (!scaffoldInPlace && fs.existsSync(projectDir)) {
        return {
          success: false,
          path: projectDir,
          error: `Directory "${projectName}" already exists at ${baseDir}`,
        };
      }

      // Scaffold files based on template
      const warnings: string[] = [];
      const postCreateSteps: PostCreateStep[] = [];
      const documents: string[] = [];
      documents.push(
        ...(await this.scaffoldByTemplate(projectDir, { ...request, projectName }, warnings, postCreateSteps))
      );

      // Initialize git if requested
      if (request.gitInit) {
        await this.initGit(projectDir, request.gitBranchName);
      }

      // Create initial commit if requested
      if (request.gitInitialCommit && request.gitInit) {
        await this.createInitialCommit(projectDir, projectName);
      }

      return {
        success: true,
        // Always arrays, even when empty: the wizard forwards these straight to
        // the webview, where `undefined` would force every consumer to guard.
        warnings,
        postCreateSteps,
        documents,
        path: projectDir,
      };
    } catch (err) {
      return {
        success: false,
        path: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Entries that don't count as project content when deciding whether a wizard
   * target folder is blank. None of them is ever written by a template, so
   * scaffolding in place can never overwrite user work: a folder holding a
   * .gitignore / package.json / etc. is NOT blank and still gets a nested
   * <projectName> directory.
   */
  private static readonly BENIGN_TARGET_ENTRIES: ReadonlySet<string> = new Set([
    '.git', // fresh `git init` — the folder itself is the repo
    '.vscode',
    '.idea',
    '.ado-code', // this extension's own metadata (memory, repo understanding)
    'node_modules',
    '__pycache__',
    '.DS_Store',
    'Thumbs.db',
    'desktop.ini',
  ]);

  /**
   * True when `dir` is empty or holds nothing but benign metadata — i.e. the
   * user handed the wizard a blank folder to build the project in.
   */
  private isBlankTargetDir(dir: string): boolean {
    try {
      return fs
        .readdirSync(dir)
        .every(entry => ProjectCreationService.BENIGN_TARGET_ENTRIES.has(entry));
    } catch {
      return false; // unreadable / not a directory — fall back to the nested flow
    }
  }

  /**
   * Route to the appropriate scaffolding method based on template ID.
   */
  private async scaffoldByTemplate(
    dir: string,
    request: ProjectCreationRequest,
    warnings: string[] = [],
    postCreateSteps: PostCreateStep[] = []
  ): Promise<string[]> {
    const template = PROJECT_TEMPLATES.find((t) => t.id === request.templateId);
    if (!template) {
      throw new Error(`Unknown template: ${request.templateId}`);
    }

    const documents: string[] = [];

    // The architecture select only reaches us through templateOptions, and
    // `microservices` is the one style with a writer today: the cross-stack
    // monorepo tree this class already produces (docs/project-scaffolding.md
    // §2.1, F2). Routing here instead of adding a second writer is what the old
    // `monorepo-microservices` template's comment anticipated — that template
    // stays as a rewriting alias so existing callers keep their exact tree.
    const architecture = resolveArchitecture(request.templateOptions);
    if (architecture === 'microservices') {
      const monorepoStackId = monorepoStackForTemplate(request.templateId);
      if (monorepoStackId) {
        await this.scaffoldMonorepoMicroservices(dir, request, warnings);
        this.appendTestAutomationSuite(dir, request, warnings, postCreateSteps);
        return documents;
      }
      // Say it rather than fake it: silently emitting a layered tree would look
      // like the architecture choice was honoured. Every stack that *has* a
      // monorepo writer is named, so the user knows what to pick instead.
      warnings.push(
        `Architecture "microservices" is not scaffolded for "${request.templateId}"; it was generated with the layered layout. Monorepo stacks: ${MONOREPO_STACKS.map((stack) => stack.label).join(', ')}.`
      );
    }

    switch (request.templateId) {
      case 'node-ts':
        await this.scaffoldNodeTs(dir, request);
        break;
      case 'node-js':
        await this.scaffoldNodeJs(dir, request);
        break;
      case 'python':
        await this.scaffoldPython(dir, request);
        break;
      case 'php-laravel':
        await this.scaffoldPhpLaravel(dir, request);
        break;
      case 'php':
        await this.scaffoldPhp(dir, request);
        break;
      case 'dotnet-webapi':
        await this.scaffoldDotNetWebApi(dir, request);
        break;
      case 'dotnet-console':
        await this.scaffoldDotNetConsole(dir, request);
        break;
      case 'react-ts':
        await this.scaffoldReactTs(dir, request);
        break;
      case 'nextjs':
        await this.scaffoldNextjs(dir, request);
        break;
      case 'react-native':
        await this.scaffoldReactNative(dir, request, warnings);
        break;
      case 'flutter':
        await this.scaffoldFlutter(dir, request, postCreateSteps);
        break;
      case 'dotnet-maui':
        await this.scaffoldDotNetMaui(dir, request, warnings);
        break;
      case 'monorepo-microservices':
        await this.scaffoldMonorepoMicroservices(dir, request, warnings);
        break;
      case 'empty':
        await this.scaffoldEmpty(dir, request);
        break;
      case 'test-automation':
        fs.mkdirSync(dir, { recursive: true });
        this.writeGitignore(dir, 'test-automation');
        this.appendTestAutomationSuite(dir, request, warnings, postCreateSteps, '');
        break;
      case 'doc-ba':
      case 'doc-writer':
      case 'doc-tester':
        documents.push(
          ...(await this.scaffoldDocProject(dir, request, DOC_PROJECT_SPECS[request.templateId], warnings))
        );
        break;
      default:
        throw new Error(`No scaffolder for template: ${request.templateId}`);
    }
    // App templates carry the same option group; there the suite is a sibling
    // of the app under tests/ rather than the project root (§7).
    if (request.templateId !== 'test-automation') {
      this.appendTestAutomationSuite(dir, request, warnings, postCreateSteps);
    }

    // Containerization belongs to the stack, not to each writer. Only two
    // templates wrote a Dockerfile before this, so the rest silently shipped
    // nothing — this is the one place that fills the gap.
    this.applyContainerization(dir, request);

    return documents;
  }

  // ──────────────────────────────────────────────
  //  Documentation projects (BA / Writer / Tester)
  // ──────────────────────────────────────────────
  private async scaffoldDocProject(
    dir: string,
    request: ProjectCreationRequest,
    spec: DocProjectSpec,
    warnings: string[]
  ): Promise<string[]> {
    // The documentation scaffolder writes its own richer .gitignore (it is not
    // a code project), so writeGitignore is deliberately not called here.
    return scaffoldDocumentationProject(dir, request, spec, warnings);
  }


  // ──────────────────────────────────────────────
  //  Node.js (TypeScript)
  // ──────────────────────────────────────────────
  private async scaffoldNodeTs(
    dir: string,
    request: ProjectCreationRequest
  ): Promise<void> {
    const { projectName: name, projectVersion: version, projectDescription: description, templateOptions: opts } = request;
    fs.mkdirSync(dir, { recursive: true });

    const pkg: Record<string, any> = {
      name,
      version: version || '0.1.0',
      description,
      scripts: {
        build: 'tsc',
        start: 'node dist/index.js',
        test: 'echo "no tests"',
      },
      devDependencies: {
        typescript: '^5.0.0',
        '@types/node': '^20.0.0',
      },
    };

    if (opts.eslint) {
      pkg.devDependencies.eslint = '^8.0.0';
      pkg.devDependencies['@typescript-eslint/eslint-plugin'] = '^6.0.0';
      pkg.devDependencies['@typescript-eslint/parser'] = '^6.0.0';
      pkg.scripts.lint = 'eslint src --ext .ts';
    }
    if (opts.prettier) {
      pkg.devDependencies.prettier = '^3.0.0';
      pkg.scripts.format = 'prettier --write "src/**/*.ts"';
    }
    if (opts.jest) {
      pkg.devDependencies.jest = '^29.0.0';
      pkg.devDependencies['ts-jest'] = '^29.0.0';
      pkg.scripts.test = 'jest';
    }

    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));

    const tsConfig: Record<string, any> = {
      compilerOptions: {
        target: 'ES2022',
        module: 'commonjs',
        outDir: 'dist',
        rootDir: 'src',
        strict: true,
        esModuleInterop: true,
      },
      include: ['src'],
      exclude: ['node_modules', 'dist'],
    };

    if (opts.jest) {
      tsConfig.jest = {
        preset: 'ts-jest',
        testEnvironment: 'node',
      };
    }

    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(tsConfig, null, 2));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), `console.log('Hello, ${name}!');\n`);

    if (opts.eslint) {
      fs.writeFileSync(
        path.join(dir, '.eslintrc.json'),
        JSON.stringify(
          {
            root: true,
            parser: '@typescript-eslint/parser',
            plugins: ['@typescript-eslint'],
            extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
          },
          null,
          2
        )
      );
    }

    if (opts.prettier) {
      fs.writeFileSync(
        path.join(dir, '.prettierrc'),
        JSON.stringify({ semi: true, singleQuote: true, tabWidth: 2 }, null, 2)
      );
    }

    if (opts.docker) {
      fs.writeFileSync(
        path.join(dir, 'Dockerfile'),
        [
          '# syntax=docker/dockerfile:1',
          `FROM ${BASE_IMAGES.node} AS build`,
          'WORKDIR /app',
          'COPY package*.json ./',
          'RUN npm install',
          'COPY . .',
          'RUN npm run build',
          '',
          `FROM ${BASE_IMAGES.node} AS runtime`,
          'ENV NODE_ENV=production',
          'WORKDIR /app',
          'COPY --from=build /app/package*.json ./',
          'COPY --from=build /app/node_modules ./node_modules',
          'COPY --from=build /app/dist ./dist',
          ...hardeningLines('node-alpine', 3000),
          'EXPOSE 3000',
          'CMD ["node", "dist/index.js"]',
        ].join('\n')
      );
    }

    this.writeGitignore(dir, 'node-ts');
  }

  // ──────────────────────────────────────────────
  //  Node.js (JavaScript)
  // ──────────────────────────────────────────────
  private async scaffoldNodeJs(
    dir: string,
    request: ProjectCreationRequest
  ): Promise<void> {
    const { projectName: name, projectVersion: version, projectDescription: description, templateOptions: opts } = request;
    fs.mkdirSync(dir, { recursive: true });

    const pkg: Record<string, any> = {
      name,
      version: version || '0.1.0',
      description,
      main: 'index.js',
      scripts: {
        start: 'node index.js',
        test: 'echo "no tests"',
      },
    };

    if (opts.eslint) {
      pkg.devDependencies = { eslint: '^8.0.0' };
      pkg.scripts.lint = 'eslint .';
    }
    if (opts.jest) {
      pkg.devDependencies = pkg.devDependencies || {};
      pkg.devDependencies.jest = '^29.0.0';
      pkg.scripts.test = 'jest';
    }

    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
    fs.writeFileSync(path.join(dir, 'index.js'), `console.log('Hello, ${name}!');\n`);

    if (opts.eslint) {
      fs.writeFileSync(
        path.join(dir, '.eslintrc.json'),
        JSON.stringify({ root: true, extends: ['eslint:recommended'] }, null, 2)
      );
    }

    this.writeGitignore(dir, 'node-js');
  }

  // ──────────────────────────────────────────────
  //  Python
  // ──────────────────────────────────────────────
  private async scaffoldPython(
    dir: string,
    request: ProjectCreationRequest
  ): Promise<void> {
    const { projectName: name, projectVersion: version, projectDescription: description, templateOptions: opts } = request;
    fs.mkdirSync(dir, { recursive: true });

    const modName = name.replace(/-/g, '_');

    let pyproject = `[project]\nname = "${name}"\nversion = "${version || '0.1.0'}"\ndescription = "${description || ''}"\nrequires-python = ">=3.9"\n\n[project.scripts]\n${name} = "${modName}:main"\n`;

    if (opts.pytest) {
      pyproject += `\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n`;
    }
    if (opts.black) {
      pyproject += `\n[tool.black]\nline-length = 88\n`;
    }
    if (opts.mypy) {
      pyproject += `\n[tool.mypy]\npython_version = "3.9"\nstrict = true\n`;
    }

    fs.writeFileSync(path.join(dir, 'pyproject.toml'), pyproject);
    fs.writeFileSync(
      path.join(dir, `${modName}.py`),
      `def main():\n    print("Hello, ${name}!")\n\nif __name__ == "__main__":\n    main()\n`
    );

    if (opts.pytest) {
      fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'tests', `test_${modName}.py`),
        `from ${modName} import main\n\ndef test_main(capsys):\n    main()\n    captured = capsys.readouterr()\n    assert "Hello" in captured.out\n`
      );
    }

    this.writeGitignore(dir, 'python');
  }

  // ──────────────────────────────────────────────
  //  PHP (Laravel)
  // ──────────────────────────────────────────────
  private async scaffoldPhpLaravel(
    dir: string,
    request: ProjectCreationRequest
  ): Promise<void> {
    const { projectName: name, templateOptions: opts } = request;
    fs.mkdirSync(dir, { recursive: true });

    const composer: Record<string, any> = {
      name: `app/${name}`,
      description: request.projectDescription || '',
      type: 'project',
      require: {
        php: '^8.1',
        'laravel/framework': '^11.0',
        'laravel/tinker': '^2.9',
      },
      'require-dev': {
        'fakerphp/faker': '^1.23',
        'laravel/pint': '^1.13',
        'laravel/sail': '^1.26',
        'mockery/mockery': '^1.6',
        'nunomaduro/collision': '^8.0',
        'phpunit/phpunit': '^11.0',
      },
      autoload: {
        'psr-4': {
          'App\\': 'app/',
          'Database\\Factories\\': 'database/factories/',
          'Database\\Seeders\\': 'database/seeders/',
        },
      },
      'autoload-dev': {
        'psr-4': {
          'Tests\\': 'tests/',
        },
      },
      scripts: {
        'post-autoload-dump': [
          '@php artisan package:discover --ansi',
          "@php artisan vendor:publish --tag=assets --ansi --force",
        ],
      },
      extra: { laravel: { 'dont-discover': [] } },
      config: {
        'optimize-autoloader': true,
        'preferred-install': 'dist',
        'sort-packages': true,
        'allow-plugins': {
          'pestphp/pest-plugin': true,
          'php-http/discovery': true,
        },
      },
      'minimum-stability': 'stable',
      'prefer-stable': true,
    };

    if (opts.pest) {
      composer['require-dev']['pestphp/pest'] = '^2.0';
    }

    fs.writeFileSync(path.join(dir, 'composer.json'), JSON.stringify(composer, null, 2));

    // Basic Laravel structure
    const dirs = [
      'app/Http/Controllers',
      'app/Models',
      'bootstrap',
      'routes',
      'config',
      'database/migrations',
      'database/seeders',
      'resources/views',
      'resources/css',
      'public',
      'tests/Feature',
      'tests/Unit',
    ];
    for (const d of dirs) {
      fs.mkdirSync(path.join(dir, d), { recursive: true });
    }

    fs.writeFileSync(
      path.join(dir, 'artisan'),
      `#!/usr/bin/env php\n<?php\n\nuse Symfony\\Component\\Console\\Input\\ArgvInput;\n\ndefine('LARAVEL_START', microtime(true));\n\nrequire __DIR__.'/vendor/autoload.php';\n\n$app = require_once __DIR__.'/bootstrap/app.php';\n\n$kernel = $app->make(Illuminate\\Contracts\\Console\\Kernel::class);\n\n$status = $kernel->handle($input = new ArgvInput, new Symfony\\Component\\Console\\Output\\ConsoleOutput);\n\n$kernel->terminate($input, $status);\n`
    );
    fs.chmodSync(path.join(dir, 'artisan'), 0o755);

    // Laravel 11 bootstrap: artisan's require_once above needs bootstrap/app.php
    fs.writeFileSync(
      path.join(dir, 'bootstrap', 'app.php'),
      `<?php\n\nuse Illuminate\\Foundation\\Application;\nuse Illuminate\\Foundation\\Configuration\\Exceptions;\nuse Illuminate\\Foundation\\Configuration\\Middleware;\n\nreturn Application::configure(basePath: dirname(__DIR__))\n    ->withRouting(\n        web: __DIR__.'/../routes/web.php',\n    )\n    ->withMiddleware(function (Middleware $middleware) {\n        //\n    })\n    ->withExceptions(function (Exceptions $exceptions) {\n        //\n    })\n    ->create();\n`
    );

    fs.writeFileSync(
      path.join(dir, 'routes', 'web.php'),
      `<?php\n\nuse Illuminate\\Support\\Facades\\Route;\n\nRoute::get('/', function () {\n    return view('welcome');\n});\n`
    );

    this.writeGitignore(dir, 'php-laravel');
  }

  // ──────────────────────────────────────────────
  //  PHP (Plain)
  // ──────────────────────────────────────────────
  private async scaffoldPhp(
    dir: string,
    request: ProjectCreationRequest
  ): Promise<void> {
    const { projectName: name } = request;
    fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(
      path.join(dir, 'composer.json'),
      JSON.stringify(
        {
          name: `app/${name}`,
          description: request.projectDescription || '',
          require: { php: '^8.1' },
          'require-dev': { 'phpunit/phpunit': '^11.0', 'squizlabs/php_codesniffer': '^3.7' },
          autoload: { 'psr-4': { 'App\\': 'src/' } },
          'autoload-dev': { 'psr-4': { 'App\\Tests\\': 'tests/' } },
        },
        null,
        2
      )
    );

    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'index.php'), `<?php\n\necho "Hello, ${name}!\n";\n`);
    fs.writeFileSync(
      path.join(dir, 'phpunit.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>\n<phpunit bootstrap="vendor/autoload.php" colors="true">\n    <testsuites>\n        <testsuite name="Unit">\n            <directory>tests</directory>\n        </testsuite>\n    </testsuites>\n</phpunit>\n`
    );

    this.writeGitignore(dir, 'php');
  }

  // ──────────────────────────────────────────────
  //  .NET (C# Web API)
  // ──────────────────────────────────────────────
  private async scaffoldDotNetWebApi(
    dir: string,
    request: ProjectCreationRequest
  ): Promise<void> {
    const { projectName: name, templateOptions: opts } = request;
    fs.mkdirSync(dir, { recursive: true });

    const csproj = `<Project Sdk="Microsoft.NET.Sdk.Web">\n\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n    <Nullable>enable</Nullable>\n    <ImplicitUsings>enable</ImplicitUsings>\n    <RootNamespace>${name}</RootNamespace>\n  </PropertyGroup>\n\n  <ItemGroup>\n    <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="8.0.0" />\n    <PackageReference Include="Swashbuckle.AspNetCore" Version="6.5.0" />\n  </ItemGroup>\n\n</Project>\n`;

    fs.writeFileSync(path.join(dir, `${name}.csproj`), csproj);
    fs.writeFileSync(
      path.join(dir, `${name}.sln`),
      `\nMicrosoft Visual Studio Solution File, Format Version 12.00\n# Visual Studio Version 17\nVisualStudioVersion = 17.0.31903.59\nMinimumVisualStudioVersion = 10.0.40219.1\nProject("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "${name}", "${name}.csproj", "{${this.newGuid()}}"\nEndProject\nGlobal\n\tGlobalSection(SolutionConfigurationPlatforms) = preSolution\n\t\tDebug|Any CPU = Debug|Any CPU\n\t\tRelease|Any CPU = Release|Any CPU\n\tEndGlobalSection\nEndGlobal\n`
    );

    fs.mkdirSync(path.join(dir, 'Controllers'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'Models'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'Program.cs'),
      `var builder = WebApplication.CreateBuilder(args);\n\nbuilder.Services.AddControllers();\nbuilder.Services.AddEndpointsApiExplorer();\nbuilder.Services.AddSwaggerGen();\n\nvar app = builder.Build();\n\nif (app.Environment.IsDevelopment())\n{\n    app.UseSwagger();\n    app.UseSwaggerUI();\n}\n\napp.UseHttpsRedirection();\napp.UseAuthorization();\napp.MapControllers();\n\napp.Run();\n`
    );
    fs.writeFileSync(
      path.join(dir, 'appsettings.json'),
      JSON.stringify(
        {
          Logging: { LogLevel: { Default: 'Information', 'Microsoft.AspNetCore': 'Warning' } },
          AllowedHosts: '*',
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(dir, 'Controllers', 'WeatherForecastController.cs'),
      `using Microsoft.AspNetCore.Mvc;\n\nnamespace ${name}.Controllers;\n\n[ApiController]\n[Route("[controller]")]\npublic class WeatherForecastController : ControllerBase\n{\n    private static readonly string[] Summaries = [\n        "Freezing", "Bracing", "Chilly", "Cool", "Mild",\n        "Warm", "Balmy", "Hot", "Sweltering", "Scorching"\n    ];\n\n    private readonly ILogger<WeatherForecastController> _logger;\n\n    public WeatherForecastController(ILogger<WeatherForecastController> logger)\n    {\n        _logger = logger;\n    }\n\n    [HttpGet] public IEnumerable<object> Get() =>\n        Enumerable.Range(1, 5).Select(index => new\n        {\n            Date = DateOnly.FromDateTime(DateTime.Now.AddDays(index)),\n            TemperatureC = Random.Shared.Next(-20, 55),\n            Summary = Summaries[Random.Shared.Next(Summaries.Length)]\n        })\n        .ToArray();\n}\n`
    );

    if (opts.docker) {
      fs.writeFileSync(
        path.join(dir, 'Dockerfile'),
        [
          `FROM ${BASE_IMAGES.dotnetAspnet} AS base`,
          'WORKDIR /app',
          '# 8080, not 80: an unprivileged container cannot bind a privileged port.',
          'EXPOSE 8080',
          '',
          `FROM ${BASE_IMAGES.dotnetSdk} AS build`,
          'WORKDIR /src',
          'COPY . .',
          'RUN dotnet restore',
          'RUN dotnet publish -c Release -o /app/publish',
          '',
          'FROM base AS final',
          'WORKDIR /app',
          'ENV ASPNETCORE_URLS=http://+:8080',
          'COPY --from=build /app/publish .',
          ...CURL_INSTALL_LINES,
          ...hardeningLines('dotnet-web', 8080),
          `ENTRYPOINT ["dotnet", "${name}.dll"]`,
        ].join('\n')
      );
    }

    this.writeGitignore(dir, 'dotnet');
  }

  // ──────────────────────────────────────────────
  //  .NET (C# Console)
  // ──────────────────────────────────────────────
  private async scaffoldDotNetConsole(
    dir: string,
    request: ProjectCreationRequest
  ): Promise<void> {
    const { projectName: name } = request;
    fs.mkdirSync(dir, { recursive: true });

    const csproj = `<Project Sdk="Microsoft.NET.Sdk">\n\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n    <TargetFramework>net8.0</TargetFramework>\n    <Nullable>enable</Nullable>\n    <ImplicitUsings>enable</ImplicitUsings>\n    <RootNamespace>${name}</RootNamespace>\n  </PropertyGroup>\n\n</Project>\n`;

    fs.writeFileSync(path.join(dir, `${name}.csproj`), csproj);
    fs.writeFileSync(path.join(dir, 'Program.cs'), `Console.WriteLine("Hello, ${name}!");\n`);

    this.writeGitignore(dir, 'dotnet');
  }

  // ──────────────────────────────────────────────
  //  React (TypeScript)
  // ──────────────────────────────────────────────
  private async scaffoldReactTs(
    dir: string,
    request: ProjectCreationRequest
  ): Promise<void> {
    const { projectName: name, projectVersion: version, projectDescription: description, templateOptions: opts } = request;
    fs.mkdirSync(dir, { recursive: true });

    const pkg: Record<string, any> = {
      name,
      version: version || '0.1.0',
      description,
      private: true,
      type: 'module',
      scripts: {
        dev: 'vite',
        build: 'tsc && vite build',
        preview: 'vite preview',
      },
      dependencies: {
        react: '^18.0.0',
        'react-dom': '^18.0.0',
      },
      devDependencies: {
        '@types/react': '^18.0.0',
        '@types/react-dom': '^18.0.0',
        '@vitejs/plugin-react': '^4.0.0',
        typescript: '^5.0.0',
        vite: '^5.0.0',
      },
    };

    if (opts.eslint) {
      pkg.devDependencies.eslint = '^8.0.0';
      pkg.devDependencies['eslint-plugin-react'] = '^7.0.0';
    }
    if (opts.prettier) {
      pkg.devDependencies.prettier = '^3.0.0';
    }
    if (opts.tailwind) {
      pkg.devDependencies.tailwindcss = '^3.0.0';
      pkg.devDependencies.postcss = '^8.0.0';
      pkg.devDependencies.autoprefixer = '^10.0.0';
    }

    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));

    fs.writeFileSync(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2020',
            useDefineForClassFields: true,
            lib: ['ES2020', 'DOM', 'DOM.Iterable'],
            module: 'ESNext',
            skipLibCheck: true,
            moduleResolution: 'bundler',
            allowImportingTsExtensions: true,
            resolveJsonModule: true,
            isolatedModules: true,
            noEmit: true,
            jsx: 'react-jsx',
            strict: true,
            noUnusedLocals: true,
            noUnusedParameters: true,
            noFallthroughCasesInSwitch: true,
          },
          include: ['src'],
        },
        null,
        2
      )
    );

    fs.writeFileSync(
      path.join(dir, 'vite.config.ts'),
      `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({\n  plugins: [react()],\n});\n`
    );

    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'public'), { recursive: true });

    fs.writeFileSync(path.join(dir, 'index.html'), `<!DOCTYPE html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>${name}</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n`);

    fs.writeFileSync(
      path.join(dir, 'src', 'main.tsx'),
      `import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport App from './App';\n\nReactDOM.createRoot(document.getElementById('root')!).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>\n);\n`
    );

    fs.writeFileSync(
      path.join(dir, 'src', 'App.tsx'),
      `function App() {\n  return (\n    <div>\n      <h1>${name}</h1>\n    </div>\n  );\n}\n\nexport default App;\n`
    );

    if (opts.eslint) {
      fs.writeFileSync(
        path.join(dir, '.eslintrc.cjs'),
        `module.exports = {\n  root: true,\n  env: { browser: true, es2020: true },\n  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'plugin:react-hooks/recommended'],\n  parser: '@typescript-eslint/parser',\n  plugins: ['react-refresh'],\n};\n`
      );
    }

    if (opts.tailwind) {
      fs.writeFileSync(
        path.join(dir, 'tailwind.config.js'),
        `/** @type {import('tailwindcss').Config} */\nexport default {\n  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],\n  theme: { extend: {} },\n  plugins: [],\n};\n`
      );
      fs.writeFileSync(
        path.join(dir, 'postcss.config.js'),
        `export default {\n  plugins: {\n    tailwindcss: {},\n    autoprefixer: {},\n  },\n};\n`
      );
    }

    this.writeGitignore(dir, 'node-ts');
  }

  // ──────────────────────────────────────────────
  //  Next.js
  // ──────────────────────────────────────────────
  private async scaffoldNextjs(
    dir: string,
    request: ProjectCreationRequest
  ): Promise<void> {
    const { projectName: name, projectVersion: version, projectDescription: description, templateOptions: opts } = request;
    fs.mkdirSync(dir, { recursive: true });

    const pkg: Record<string, any> = {
      name,
      version: version || '0.1.0',
      description,
      private: true,
      scripts: {
        dev: 'next dev',
        build: 'next build',
        start: 'next start',
        lint: 'next lint',
      },
      dependencies: {
        next: '^14.0.0',
        react: '^18.0.0',
        'react-dom': '^18.0.0',
      },
      devDependencies: {
        '@types/node': '^20.0.0',
        '@types/react': '^18.0.0',
        '@types/react-dom': '^18.0.0',
        typescript: '^5.0.0',
      },
    };

    if (opts.tailwind) {
      pkg.devDependencies.tailwindcss = '^3.0.0';
      pkg.devDependencies.postcss = '^8.0.0';
      pkg.devDependencies.autoprefixer = '^10.0.0';
    }
    if (opts.prisma) {
      pkg.devDependencies.prisma = '^5.0.0';
    }

    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));

    fs.writeFileSync(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2017',
            lib: ['dom', 'dom.iterable', 'esnext'],
            allowJs: true,
            skipLibCheck: true,
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            module: 'esnext',
            moduleResolution: 'bundler',
            resolveJsonModule: true,
            isolatedModules: true,
            jsx: 'preserve',
            incremental: true,
            plugins: [{ name: 'next' }],
            paths: { '@/*': ['./src/*'] },
          },
          include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
          exclude: ['node_modules'],
        },
        null,
        2
      )
    );

    fs.writeFileSync(
      path.join(dir, 'next.config.js'),
      `/** @type {import('next').NextConfig} */\nconst nextConfig = {};\n\nmodule.exports = nextConfig;\n`
    );

    fs.mkdirSync(path.join(dir, 'src', 'app'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'app', 'layout.tsx'),
      `import type { Metadata } from 'next';\n${opts.tailwind ? "import './globals.css';\n" : ''}\nexport const metadata: Metadata = {\n  title: '${name}',\n  description: '${description || ''}',\n};\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}\n`
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'app', 'page.tsx'),
      `export default function Home() {\n  return (\n    <main>\n      <h1>${name}</h1>\n    </main>\n  );\n}\n`
    );

    if (opts.tailwind) {
      fs.writeFileSync(
        path.join(dir, 'tailwind.config.js'),
        `/** @type {import('tailwindcss').Config} */\nmodule.exports = {\n  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],\n  theme: { extend: {} },\n  plugins: [],\n};\n`
      );
      fs.writeFileSync(
        path.join(dir, 'postcss.config.js'),
        `module.exports = {\n  plugins: {\n    tailwindcss: {},\n    autoprefixer: {},\n  },\n};\n`
      );
      fs.writeFileSync(
        path.join(dir, 'src', 'app', 'globals.css'),
        `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n`
      );
    }

    if (opts.prisma) {
      fs.mkdirSync(path.join(dir, 'prisma'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'prisma', 'schema.prisma'), `// Prisma schema\n\ndatasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n\ngenerator client {\n  provider = "prisma-client-js"\n}\n`);
    }

    this.writeGitignore(dir, 'node-ts');
  }

  // ──────────────────────────────────────────────
  //  Empty Project
  // ──────────────────────────────────────────────
  // ──────────────────────────────────────────────
  //  Shared helpers — mobile & monorepo templates
  // ──────────────────────────────────────────────

  /** Lowercase, path-safe slug for folders, package names and labels. */
  private slug(value: string, fallback: string): string {
    const slugged = String(value ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return slugged || fallback;
  }

  /** PascalCase identifier, safe as a C# namespace or project name. */
  private pascal(value: string): string {
    const parts = String(value ?? '')
      .split(/[^A-Za-z0-9]+/)
      .filter((part) => part.length > 0);
    const joined = parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
    return /^[A-Za-z]/.test(joined) ? joined : `App${joined}`;
  }

  /** The `services` wizard option → deduped, path-safe names (never empty). */
  private parseServiceNames(raw: unknown): string[] {
    const names = String(raw ?? '')
      .split(',')
      .map((part) => this.slug(part, ''))
      .filter((part) => part.length > 0);
    const unique = Array.from(new Set(names));
    return unique.length > 0 ? unique : ['api', 'worker'];
  }

  /**
   * When set, writes are *captured* instead of performed — `/new-service`
   * needs the artifacts before it can decide to keep them.
   */
  private captureSink: Record<string, string> | null = null;

  /** Write a file below `dir`, creating parent folders as needed. */
  private writeProjectFile(dir: string, relPath: string, content: string): void {
    if (this.captureSink) {
      this.captureSink[relPath.replace(/\\/g, '/')] = content;
      return;
    }
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  // ──────────────────────────────────────────────
  //  Mobile — React Native (Expo managed or bare CLI)
  // ──────────────────────────────────────────────
  private async scaffoldReactNative(
    dir: string,
    request: ProjectCreationRequest,
    warnings: string[] = []
  ): Promise<void> {
    const {
      projectName: name,
      projectVersion: version,
      projectDescription: description,
      templateOptions: opts,
    } = request;
    fs.mkdirSync(dir, { recursive: true });

    const slug = this.slug(name, 'rn-app');
    const expo = opts.expo !== false;
    const typescript = opts.typescript !== false;
    const navigation = expo && typeof opts.navigation === 'string' ? opts.navigation : 'none';
    const state = typeof opts.stateManagement === 'string' ? opts.stateManagement : 'none';
    const useRouter = navigation === 'expo-router';
    const useReactNavigation = navigation === 'react-navigation';
    const withZustand = state === 'zustand';
    const withRedux = state === 'redux-toolkit';
    const ext = typescript ? 'tsx' : 'jsx';

    // ── package.json ──────────────────────────────
    const dependencies: Record<string, string> = expo
      ? { expo: '^51.0.0', react: '18.2.0', 'react-native': '0.74.5', 'expo-status-bar': '~1.12.1' }
      : { react: '18.2.0', 'react-native': '0.74.5' };
    if (useRouter) {
      Object.assign(dependencies, {
        'expo-router': '~3.5.0',
        'expo-constants': '~16.0.2',
        'expo-linking': '~6.3.1',
        'react-native-safe-area-context': '4.10.5',
        'react-native-screens': '3.31.1',
      });
    } else if (useReactNavigation) {
      Object.assign(dependencies, {
        '@react-navigation/native': '^6.1.17',
        '@react-navigation/native-stack': '^6.9.26',
        'react-native-safe-area-context': '4.10.5',
        'react-native-screens': '3.31.1',
      });
    }
    if (withZustand) {
      dependencies.zustand = '^4.5.2';
    }
    if (withRedux) {
      Object.assign(dependencies, { '@reduxjs/toolkit': '^2.2.6', 'react-redux': '^9.1.2' });
    }

    const devDependencies: Record<string, string> = expo
      ? {}
      : {
          '@react-native/babel-preset': '0.74.87',
          '@react-native/metro-config': '0.74.87',
          '@react-native-community/cli': '14.0.0',
        };
    if (typescript) {
      Object.assign(devDependencies, { typescript: '~5.3.3', '@types/react': '~18.2.79' });
    }
    if (opts.testing) {
      Object.assign(devDependencies, { jest: '^29.7.0', '@testing-library/react-native': '^12.5.1' });
      if (expo) {
        Object.assign(devDependencies, { 'jest-expo': '~51.0.2' });
      } else {
        Object.assign(devDependencies, { 'react-test-renderer': '18.2.0' });
      }
      if (typescript) {
        devDependencies['@types/jest'] = '^29.5.12';
      }
    }
    if (opts.eslint) {
      Object.assign(devDependencies, { prettier: '^3.3.3' });
      if (expo) {
        Object.assign(devDependencies, { eslint: '^8.57.0', 'eslint-config-expo': '^7.1.1' });
      } else {
        Object.assign(devDependencies, { eslint: '^8.57.0', '@react-native-community/eslint-config': '^3.2.2' });
      }
    }

    const scripts: Record<string, string> = expo
      ? {
          start: 'expo start',
          android: 'expo start --android',
          ios: 'expo start --ios',
          web: 'expo start --web',
        }
      : { start: 'react-native start', android: 'react-native run-android', ios: 'react-native run-ios' };
    if (opts.testing) {
      scripts.test = 'jest';
    }
    if (opts.eslint) {
      scripts.lint = 'eslint . --ext .js,.jsx,.ts,.tsx';
      scripts.format = 'prettier --write .';
    }

    const pkg: Record<string, any> = {
      name: slug,
      version: version || '0.1.0',
      description,
      private: true,
      main: expo ? (useRouter ? 'expo-router/entry' : 'node_modules/expo/AppEntry.js') : 'index.js',
      scripts,
      dependencies,
      devDependencies,
    };
    if (opts.testing) {
      pkg.jest = {
        preset: expo ? 'jest-expo' : 'react-native',
        transformIgnorePatterns: [
          'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|expo-router|react-navigation|@react-navigation/.*|react-native-.*|zustand))',
        ],
      };
    }
    this.writeProjectFile(dir, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`);

    // ── app configuration ─────────────────────────
    if (expo) {
      const appConfig: Record<string, any> = {
        expo: {
          name,
          slug,
          version: version || '0.1.0',
          orientation: 'portrait',
          scheme: slug.replace(/-/g, ''),
          userInterfaceStyle: 'automatic',
          newArchEnabled: true,
          ios: { supportsTablet: true, bundleIdentifier: `com.${slug.replace(/-/g, '')}.app` },
          android: { package: `com.${slug.replace(/-/g, '')}.app`, edgeToEdgeEnabled: true },
          web: { bundler: 'metro', output: 'static' },
        },
      };
      if (useRouter) {
        appConfig.expo.plugins = ['expo-router'];
        appConfig.expo.experiments = { typedRoutes: true };
      }
      this.writeProjectFile(dir, 'app.json', `${JSON.stringify(appConfig, null, 2)}\n`);
    } else {
      this.writeProjectFile(
        dir,
        'app.json',
        `${JSON.stringify({ name: slug, displayName: name }, null, 2)}\n`
      );
      this.writeProjectFile(
        dir,
        'babel.config.js',
        "module.exports = {\n  presets: ['module:@react-native/babel-preset'],\n};\n"
      );
      this.writeProjectFile(
        dir,
        'metro.config.js',
        "const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');\n\nconst config = {};\n\nmodule.exports = mergeConfig(getDefaultConfig(__dirname), config);\n"
      );
      this.writeProjectFile(
        dir,
        'index.js',
        "import { AppRegistry } from 'react-native';\nimport App from './App';\nimport { name as appName } from './app.json';\n\nAppRegistry.registerComponent(appName, () => App);\n"
      );
    }

    if (typescript) {
      const tsconfig: Record<string, any> = {
        extends: expo ? 'expo/tsconfig.base' : '@react-native/typescript-config/tsconfig.json',
        compilerOptions: {
          strict: true,
          resolveJsonModule: true,
          jsx: 'react-jsx',
          baseUrl: '.',
          paths: { '@/*': ['./src/*'] },
        },
        include: ['**/*.ts', '**/*.tsx', '.expo/types/**/*.ts', 'expo-env.d.ts'],
        exclude: ['node_modules'],
      };
      if (!expo) {
        delete tsconfig.extends;
        tsconfig.compilerOptions = { ...tsconfig.compilerOptions, target: 'ESNext', module: 'ESNext', moduleResolution: 'bundler' };
      }
      this.writeProjectFile(dir, 'tsconfig.json', `${JSON.stringify(tsconfig, null, 2)}\n`);
      if (!expo) {
        devDependencies['@react-native/typescript-config'] = '0.74.87';
        pkg.devDependencies = devDependencies;
        this.writeProjectFile(dir, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`);
      }
    }

    if (opts.eslint) {
      this.writeProjectFile(dir, '.prettierrc', '{ "singleQuote": true, "printWidth": 100 }\n');
      this.writeProjectFile(
        dir,
        '.eslintrc.js',
        `module.exports = {
  root: true,
  extends: '${expo ? 'expo' : '@react-native-community'}',
};
`
      );
    }

    // ── state store ───────────────────────────────
    if (withZustand) {
      this.writeProjectFile(
        dir,
        `src/store/useAppStore.${typescript ? 'ts' : 'js'}`,
        `import { create } from 'zustand';

export const useAppStore = create((set) => ({
  count: 0,
  increment: () => set((state) => ({ count: state.count + 1 })),
  reset: () => set({ count: 0 }),
}));
`
      );
    }
    if (withRedux) {
      this.writeProjectFile(
        dir,
        `src/store/counterSlice.${typescript ? 'ts' : 'js'}`,
        `import { createSlice } from '@reduxjs/toolkit';

const counterSlice = createSlice({
  name: 'counter',
  initialState: { value: 0 },
  reducers: {
    increment: (state) => {
      state.value += 1;
    },
    reset: (state) => {
      state.value = 0;
    },
  },
});

export const { increment, reset } = counterSlice.actions;
export default counterSlice.reducer;
`
      );
      this.writeProjectFile(
        dir,
        `src/store/store.${typescript ? 'ts' : 'js'}`,
        `import { configureStore } from '@reduxjs/toolkit';
import counterReducer from './counterSlice';

export const store = configureStore({
  reducer: { counter: counterReducer },
});
`
      );
    }

    // ── home screen ───────────────────────────────
    const homeImports = [
      "import { StyleSheet, Text, View } from 'react-native';",
      withZustand ? "import { useAppStore } from '../store/useAppStore';" : '',
      withRedux ? "import { useDispatch, useSelector } from 'react-redux';\nimport { increment } from '../store/counterSlice';" : '',
    ]
      .filter(Boolean)
      .join('\n');
    const homeState = [
      withZustand ? '  const count = useAppStore((state) => state.count);\n  const increment = useAppStore((state) => state.increment);' : '',
      withRedux
        ? '  const count = useSelector((state) => state.counter.value);\n  const dispatch = useDispatch();\n  const increment = () => dispatch({ type: \'counter/increment\' });'
        : '',
      !withZustand && !withRedux ? '  const count = 0;' : '',
    ]
      .filter(Boolean)
      .join('\n');
    const homeOnPress = withZustand || withRedux ? 'onPress={increment}' : 'onPress={() => {}}';
    this.writeProjectFile(
      dir,
      `src/screens/HomeScreen.${ext}`,
      `${homeImports}

export default function HomeScreen() {
${homeState}

  return (
    <View style={styles.container}>
      <Text style={styles.title}>${name.replace(/\\/g, '')}</Text>
      <Text style={styles.subtitle}>Mobile app scaffolded with ADO Code</Text>
      <Text style={styles.counter}>Taps: {count}</Text>
      <Text style={styles.button} ${homeOnPress}>
        Increment
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  title: { fontSize: 24, fontWeight: '700' },
  subtitle: { fontSize: 14, opacity: 0.6, textAlign: 'center' },
  counter: { fontSize: 18 },
  button: {
    marginTop: 8,
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
    backgroundColor: '#2563eb',
    color: '#fff',
    overflow: 'hidden',
  },
});
`
    );

    // ── app entry ─────────────────────────────────
    if (useRouter) {
      const layoutImports = [
        "import { Stack } from 'expo-router';",
        withRedux ? "import { Provider } from 'react-redux';\nimport { store } from '../src/store/store';" : '',
      ]
        .filter(Boolean)
        .join('\n');
      const stack = `    <Stack screenOptions={{ headerShown: true }}>
      <Stack.Screen name="index" options={{ title: '${name.replace(/'/g, '')}' }} />
    </Stack>`;
      const layoutBody = withRedux ? `    <Provider store={store}>\n${stack}\n    </Provider>` : stack;
      this.writeProjectFile(
        dir,
        `app/_layout.${ext}`,
        `${layoutImports}

export default function RootLayout() {
  return (
${layoutBody}
  );
}
`
      );
      this.writeProjectFile(dir, `app/index.${ext}`, "export { default } from '../src/screens/HomeScreen';\n");
    } else {
      const appImports = [
        "import { StyleSheet, SafeAreaView } from 'react-native';",
        expo ? "import { StatusBar } from 'expo-status-bar';" : '',
        useReactNavigation
          ? "import { NavigationContainer } from '@react-navigation/native';\nimport { createNativeStackNavigator } from '@react-navigation/native-stack';"
          : '',
        withRedux ? "import { Provider } from 'react-redux';\nimport { store } from './src/store/store';" : '',
        "import HomeScreen from './src/screens/HomeScreen';",
        useReactNavigation ? '\nconst Stack = createNativeStackNavigator();' : '',
      ]
        .filter(Boolean)
        .join('\n');
      const screen = useReactNavigation
        ? `      <NavigationContainer>
        <Stack.Navigator>
          <Stack.Screen name="Home" component={HomeScreen} options={{ headerShown: false }} />
        </Stack.Navigator>
      </NavigationContainer>`
        : '      <HomeScreen />';
      const tree = `    <SafeAreaView style={styles.root}>
${expo ? '      <StatusBar style="auto" />\n' : ''}${screen}
    </SafeAreaView>`;
      const appBody = withRedux ? `    <Provider store={store}>\n${tree}\n    </Provider>` : tree;
      this.writeProjectFile(
        dir,
        `App.${ext}`,
        `${appImports}

export default function App() {
  return (
${appBody}
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
`
      );
    }

    // ── tests ─────────────────────────────────────
    if (opts.testing) {
      this.writeProjectFile(
        dir,
        `__tests__/HomeScreen.test.${ext}`,
        `import { render } from '@testing-library/react-native';
import HomeScreen from '../src/screens/HomeScreen';

describe('HomeScreen', () => {
  it('renders the app title', () => {
    const screen = render(<HomeScreen />);
    expect(screen.getByText('${name.replace(/'/g, '')}')).toBeTruthy();
  });
});
`
      );
    }

    this.writeProjectFile(
      dir,
      'README.md',
      `# ${name}

${description || 'Cross-platform mobile app.'}

## Getting started

\`\`\`bash
npm install
${expo ? 'npm start        # Expo dev server (press a / i for Android / iOS)' : 'npm start        # Metro bundler\nnpm run android  # build + run on an Android device or emulator\nnpm run ios      # build + run on an iOS simulator (macOS only)'}
\`\`\`

${expo ? 'Ships the Expo managed workflow with an `app.json` manifest and EAS-ready layout.' : 'Bare React Native CLI project — native folders are generated by the Android/iOS toolchain.'}

## Layout

| Path | Purpose |
| --- | --- |
| \`src/screens/HomeScreen.${ext}\` | First screen |
| \`src/store/\` | ${withZustand ? 'Zustand store' : withRedux ? 'Redux Toolkit store' : 'State management (add one as needed)'} |
| \`${useRouter ? 'app/' : `App.${ext}`}\` | ${useRouter ? 'Expo Router file-based routes' : 'App root component'} |

## Platforms

${[opts.android !== false ? '- Android' : '', opts.ios !== false ? '- iOS' : '', '- Web (Expo)'].filter(Boolean).join('\n')}
`
    );

    this.writeGitignore(dir, 'react-native');
    if (!expo) {
      warnings.push(
        'Bare React Native: native project folders are created by the CLI. Install Android Studio / Xcode, then run `npm run android` or `npm run ios`.'
      );
    }
  }

  // ──────────────────────────────────────────────
  //  Mobile — Flutter
  // ──────────────────────────────────────────────
  private async scaffoldFlutter(
    dir: string,
    request: ProjectCreationRequest,
    postCreateSteps: PostCreateStep[] = []
  ): Promise<void> {
    const { projectName: name, projectVersion: version, projectDescription: description, templateOptions: opts } = request;
    fs.mkdirSync(dir, { recursive: true });

    const pkgName = this.slug(name, 'flutter_app').replace(/-/g, '_');
    const state = typeof opts.stateManagement === 'string' ? opts.stateManagement : 'none';
    const httpClient = typeof opts.httpClient === 'string' ? opts.httpClient : 'dio';
    const platforms = [
      opts.android !== false ? 'android' : '',
      opts.ios !== false ? 'ios' : '',
      opts.web === true ? 'web' : '',
    ].filter(Boolean);

    const dependencies = [
      '  flutter:',
      '    sdk: flutter',
      '  cupertino_icons: ^1.0.8',
      state === 'provider' ? '  provider: ^6.1.2' : '',
      state === 'riverpod' ? '  flutter_riverpod: ^2.5.1' : '',
      state === 'bloc' ? '  flutter_bloc: ^8.1.6' : '',
      httpClient === 'dio' ? '  dio: ^5.5.0' : '  http: ^1.2.1',
    ]
      .filter(Boolean)
      .join('\n');

    this.writeProjectFile(
      dir,
      'pubspec.yaml',
      `name: ${pkgName}
description: ${(description || name).replace(/\n/g, ' ')}
publish_to: 'none'
version: ${version || '0.1.0'}+1

environment:
  sdk: '>=3.4.0 <4.0.0'
  flutter: '>=3.22.0'

dependencies:
${dependencies}

dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: ^4.0.0

flutter:
  uses-material-design: true
`
    );

    this.writeProjectFile(
      dir,
      'analysis_options.yaml',
      `include: package:flutter_lints/flutter.yaml

linter:
  rules:
    prefer_const_constructors: true
    prefer_final_locals: true
`
    );

    const mainImports = [
      "import 'package:flutter/material.dart';",
      state === 'riverpod' ? "import 'package:flutter_riverpod/flutter_riverpod.dart';" : '',
      state === 'provider' ? "import 'package:provider/provider.dart';" : '',
      state === 'bloc' ? "import 'package:flutter_bloc/flutter_bloc.dart';" : '',
      '',
      "import 'app.dart';",
      state === 'provider' ? "import 'state/counter_controller.dart';" : '',
      state === 'bloc' ? "import 'state/counter_cubit.dart';" : '',
    ]
      .filter((line, index, all) => line !== '' || index === all.indexOf(''))
      .join('\n');
    const mainBody =
      state === 'riverpod'
        ? "  runApp(const ProviderScope(child: App()));"
        : state === 'provider'
          ? `  runApp(
    ChangeNotifierProvider(
      create: (_) => CounterController(),
      child: const App(),
    ),
  );`
          : state === 'bloc'
            ? `  runApp(
    BlocProvider(
      create: (_) => CounterCubit(),
      child: const App(),
    ),
  );`
            : '  runApp(const App());';
    this.writeProjectFile(
      dir,
      'lib/main.dart',
      `${mainImports}

void main() {
${mainBody}
}
`
    );

    this.writeProjectFile(
      dir,
      'lib/app.dart',
      `import 'package:flutter/material.dart';

import 'features/home/presentation/home_screen.dart';

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '${name.replace(/'/g, '')}',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(colorSchemeSeed: Colors.indigo, useMaterial3: true),
      home: const HomeScreen(),
    );
  }
}
`
    );

    if (state === 'provider') {
      this.writeProjectFile(
        dir,
        'lib/state/counter_controller.dart',
        `import 'package:flutter/foundation.dart';

class CounterController extends ChangeNotifier {
  int _count = 0;

  int get count => _count;

  void increment() {
    _count += 1;
    notifyListeners();
  }
}
`
      );
    }
    if (state === 'riverpod') {
      this.writeProjectFile(
        dir,
        'lib/state/counter_provider.dart',
        `import 'package:flutter_riverpod/flutter_riverpod.dart';

final counterProvider = StateNotifierProvider<CounterNotifier, int>((ref) {
  return CounterNotifier();
});

class CounterNotifier extends StateNotifier<int> {
  CounterNotifier() : super(0);

  void increment() => state = state + 1;
}
`
      );
    }
    if (state === 'bloc') {
      this.writeProjectFile(
        dir,
        'lib/state/counter_cubit.dart',
        `import 'package:flutter_bloc/flutter_bloc.dart';

class CounterCubit extends Cubit<int> {
  CounterCubit() : super(0);

  void increment() => emit(state + 1);
}
`
      );
    }

    this.writeProjectFile(
      dir,
      'lib/core/api_client.dart',
      httpClient === 'dio'
        ? `import 'package:dio/dio.dart';

class ApiClient {
  ApiClient({String? baseUrl})
      : _dio = Dio(
          BaseOptions(
            baseUrl: baseUrl ?? 'https://api.example.com',
            connectTimeout: const Duration(seconds: 10),
            receiveTimeout: const Duration(seconds: 10),
          ),
        );

  final Dio _dio;

  Future<Map<String, dynamic>> get(String path) async {
    final response = await _dio.get<Map<String, dynamic>>(path);
    return response.data ?? <String, dynamic>{};
  }
}
`
        : `import 'dart:convert';

import 'package:http/http.dart' as http;

class ApiClient {
  ApiClient({this.baseUrl = 'https://api.example.com'});

  final String baseUrl;

  Future<Map<String, dynamic>> get(String path) async {
    final response = await http.get(Uri.parse('$baseUrl$path'));
    if (response.statusCode != 200) {
      throw Exception('Request failed with status $' + '{response.statusCode}');
    }
    return jsonDecode(response.body) as Map<String, dynamic>;
  }
}
`
    );

    const homeImports = [
      "import 'package:flutter/material.dart';",
      state === 'riverpod' ? "import 'package:flutter_riverpod/flutter_riverpod.dart';" : '',
      state === 'provider' ? "import 'package:provider/provider.dart';" : '',
      state === 'bloc' ? "import 'package:flutter_bloc/flutter_bloc.dart';" : '',
      state === 'riverpod' ? "import '../../../state/counter_provider.dart';" : '',
      state === 'provider' ? "import '../../../state/counter_controller.dart';" : '',
      state === 'bloc' ? "import '../../../state/counter_cubit.dart';" : '',
    ]
      .filter(Boolean)
      .join('\n');

    const counterWidget = {
      riverpod: "'Taps: ' + ref.watch(counterProvider).toString()",
      provider: "'Taps: ' + context.watch<CounterController>().count.toString()",
      bloc: "'Taps: ' + state.toString()",
      none: "'Taps: 0'",
    }[state] || "'Taps: 0'";
    const onPressed = {
      riverpod: 'onPressed: () => ref.read(counterProvider.notifier).increment(),',
      provider: 'onPressed: () => context.read<CounterController>().increment(),',
      bloc: 'onPressed: () => context.read<CounterCubit>().increment(),',
      none: 'onPressed: () {},',
    }[state] || 'onPressed: () {},';

    const flutterHead = (widget: string) =>
      'class HomeScreen extends ' +
      widget +
      ' {' +
      `\n  const HomeScreen({super.key});\n\n  @override\n  Widget build(` +
      (widget === 'ConsumerWidget' ? 'BuildContext context, WidgetRef ref' : 'BuildContext context') +
      ') {';

    const scaffoldBody = (indent: string) =>
      indent + 'return Scaffold(' +
      `\n${indent}  appBar: AppBar(title: const Text('${name.replace(/'/g, '')}')),` +
      `\n${indent}  body: Center(` +
      `\n${indent}    child: Column(` +
      `\n${indent}      mainAxisAlignment: MainAxisAlignment.center,` +
      `\n${indent}      children: [` +
      `\n${indent}        Text(${counterWidget}, style: Theme.of(context).textTheme.titleMedium),` +
      `\n${indent}        const SizedBox(height: 12),` +
      `\n${indent}        FilledButton(` +
      `\n${indent}          ${onPressed}` +
      `\n${indent}          child: const Text('Increment'),` +
      `\n${indent}        ),` +
      `\n${indent}      ],` +
      `\n${indent}    ),` +
      `\n${indent}  ),` +
      `\n${indent});`;

    let homeSource: string;
    if (state === 'riverpod') {
      homeSource = `${homeImports}

${flutterHead('ConsumerWidget')}
${scaffoldBody('    ')}
  }
}
`;
    } else if (state === 'bloc') {
      homeSource = `${homeImports}

${flutterHead('StatelessWidget')}
    return BlocBuilder<CounterCubit, int>(
      builder: (context, state) {
${scaffoldBody('        ')}
      },
    );
  }
}
`;
    } else {
      homeSource = `${homeImports}

${flutterHead('StatelessWidget')}
${scaffoldBody('    ')}
  }
}
`;
    }
    this.writeProjectFile(dir, 'lib/features/home/presentation/home_screen.dart', homeSource);

    if (opts.testing) {
      this.writeProjectFile(
        dir,
        'test/widget_test.dart',
        `import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
${state === 'provider' ? "import 'package:provider/provider.dart';\n" : ''}${state === 'riverpod' ? "import 'package:flutter_riverpod/flutter_riverpod.dart';\n" : ''}${state === 'bloc' ? "import 'package:flutter_bloc/flutter_bloc.dart';\n" : ''}
import 'package:${pkgName}/app.dart';
${state === 'provider' ? `import 'package:${pkgName}/state/counter_controller.dart';\n` : ''}${state === 'riverpod' ? `import 'package:${pkgName}/state/counter_provider.dart';\n` : ''}${state === 'bloc' ? `import 'package:${pkgName}/state/counter_cubit.dart';\n` : ''}
void main() {
  testWidgets('home screen renders the app bar', (WidgetTester tester) async {
    await tester.pumpWidget(${state === 'riverpod' ? 'const ProviderScope(child: App())' : state === 'bloc' ? 'BlocProvider(create: (_) => CounterCubit(), child: const App())' : 'const App()'});
    await tester.pumpAndSettle();

    expect(find.text('${name.replace(/'/g, '')}'), findsOneWidget);
    expect(find.text('Increment'), findsOneWidget);
  });
}
`
      );
    }

    this.writeProjectFile(
      dir,
      'README.md',
      `# ${name}

${description || 'Cross-platform mobile app built with Flutter.'}

## Getting started

\`\`\`bash
flutter pub get
flutter create . --platforms=${platforms.join(',') || 'android,ios'}   # generates the native runners
flutter run
\`\`\`

The platform folders (\`android/\`, \`ios/\`${opts.web === true ? ', `web/`' : ''}) are produced by the Flutter SDK, so they are
not part of the scaffold — run the command above once to create them.

## Layout

| Path | Purpose |
| --- | --- |
| \`lib/main.dart\` | Entry point${state === 'none' ? '' : ' + state wiring'} |
| \`lib/app.dart\` | MaterialApp / theme |
| \`lib/core/api_client.dart\` | ${httpClient === 'dio' ? 'Dio' : 'package:http'} API client |
| \`lib/features/home/\` | Feature-first folder for the home screen |
| \`lib/state/\` | ${state === 'none' ? 'State management (add one as needed)' : `${state} state`} |

## Targets

${platforms.map((platform) => `- ${platform}`).join('\n') || '- android, ios'}
`
    );

    this.writeGitignore(dir, 'flutter');
    // The native runners are SDK-generated, so this is a real step for the
    // user rather than a footnote: the wizard's final "Next Steps" step shows
    // it with the command ready to copy.
    postCreateSteps.push({
      label: 'Generate the native runners',
      command: `flutter create . --platforms=${platforms.join(',') || 'android,ios'}`,
      detail:
        'The android/ and ios/ folders (plus web/ when selected) are produced by the Flutter SDK, not by the scaffold. ' +
        'Run this once in the project root — it merges into the existing lib/ and pubspec.yaml — then `flutter run`.',
    });
  }

  // ──────────────────────────────────────────────
  //  Mobile — .NET MAUI
  // ──────────────────────────────────────────────
  private async scaffoldDotNetMaui(
    dir: string,
    request: ProjectCreationRequest,
    warnings: string[] = []
  ): Promise<void> {
    const { projectName: name, projectDescription: description, templateOptions: opts } = request;
    fs.mkdirSync(dir, { recursive: true });

    const appId = this.pascal(name);
    const android = opts.android !== false;
    const ios = opts.ios !== false;
    const windows = opts.windows === true;
    const mvvm = opts.mvvm !== false;
    const targets = [
      android ? 'net8.0-android' : '',
      ios ? 'net8.0-ios' : '',
      windows ? 'net8.0-windows10.0.19041.0' : '',
    ].filter(Boolean);
    const targetFrameworks = targets.length > 0 ? targets.join(';') : 'net8.0-android';
    const applicationId = `com.${this.slug(name, 'mauiapp').replace(/-/g, '')}.app`;

    const mauiPackages = [
      '    <PackageReference Include="Microsoft.Maui.Controls" Version="8.0.80" />',
      '    <PackageReference Include="Microsoft.Extensions.Logging.Debug" Version="8.0.0" />',
      mvvm ? '    <PackageReference Include="CommunityToolkit.Mvvm" Version="8.2.2" />' : '',
    ]
      .filter(Boolean)
      .join('\n');

    this.writeProjectFile(
      dir,
      `${appId}.csproj`,
      `<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <TargetFrameworks>${targetFrameworks}</TargetFrameworks>
    <OutputType>Exe</OutputType>
    <RootNamespace>${appId}</RootNamespace>
    <UseMaui>true</UseMaui>
    <SingleProject>true</SingleProject>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>

    <ApplicationTitle>${name.replace(/[<>&]/g, '')}</ApplicationTitle>
    <ApplicationId>${applicationId}</ApplicationId>
    <ApplicationDisplayVersion>1.0</ApplicationDisplayVersion>
    <ApplicationVersion>1</ApplicationVersion>

    <SupportedOSPlatformVersion Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'ios'">15.0</SupportedOSPlatformVersion>
    <SupportedOSPlatformVersion Condition="$([MSBuild]::GetTargetPlatformIdentifier('$(TargetFramework)')) == 'android'">21.0</SupportedOSPlatformVersion>
  </PropertyGroup>

  <ItemGroup>
    <MauiIcon Include="Resources\\AppIcon\\appicon.svg" ForegroundFile="Resources\\AppIcon\\appiconfg.svg" Color="#512BD4" />
    <MauiSplashScreen Include="Resources\\Splash\\splash.svg" Color="#512BD4" BaseSize="128,128" />
    <MauiImage Include="Resources\\Images\\*" />
  </ItemGroup>

  <ItemGroup>
${mauiPackages}
  </ItemGroup>

</Project>
`
    );

    this.writeProjectFile(
      dir,
      'MauiProgram.cs',
      `using Microsoft.Extensions.Logging;

namespace ${appId};

public static class MauiProgram
{
    public static MauiApp CreateMauiApp()
    {
        var builder = MauiApp.CreateBuilder();
        builder.UseMauiApp<App>();

#if DEBUG
        builder.Logging.AddDebug();
#endif

        return builder.Build();
    }
}
`
    );

    this.writeProjectFile(
      dir,
      'App.xaml',
      `<?xml version="1.0" encoding="UTF-8" ?>
<Application xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
             xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml"
             x:Class="${appId}.App">
    <Application.Resources>
        <ResourceDictionary>
            <ResourceDictionary.MergedDictionaries>
                <ResourceDictionary Source="Resources/Styles/Colors.xaml" />
                <ResourceDictionary Source="Resources/Styles/Styles.xaml" />
            </ResourceDictionary.MergedDictionaries>
        </ResourceDictionary>
    </Application.Resources>
</Application>
`
    );
    this.writeProjectFile(
      dir,
      'App.xaml.cs',
      `namespace ${appId};

public partial class App : Application
{
    public App()
    {
        InitializeComponent();
        MainPage = new AppShell();
    }
}
`
    );

    this.writeProjectFile(
      dir,
      'AppShell.xaml',
      `<?xml version="1.0" encoding="UTF-8" ?>
<Shell xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
       xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml"
       xmlns:local="clr-namespace:${appId}"
       x:Class="${appId}.AppShell"
       Title="${name.replace(/[<>&"]/g, '')}">
    <ShellContent Title="Home" ContentTemplate="{DataTemplate local:MainPage}" Route="MainPage" />
</Shell>
`
    );
    this.writeProjectFile(
      dir,
      'AppShell.xaml.cs',
      `namespace ${appId};

public partial class AppShell : Shell
{
    public AppShell()
    {
        InitializeComponent();
    }
}
`
    );

    this.writeProjectFile(
      dir,
      'MainPage.xaml',
      `<?xml version="1.0" encoding="utf-8" ?>
<ContentPage xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
             xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml"
             x:Class="${appId}.MainPage"
             Title="Home">
    <VerticalStackLayout Padding="24" Spacing="12" VerticalOptions="Center">
        <Label Text="${name.replace(/[<>&"]/g, '')}" FontSize="28" FontAttributes="Bold" HorizontalOptions="Center" />
        <Label Text="Mobile app scaffolded with ADO Code" FontSize="14" HorizontalOptions="Center" />
        <Label Text="{Binding Counter, StringFormat='Taps: {0}'}" FontSize="18" HorizontalOptions="Center" />
        <Button Text="Increment" Command="{Binding IncrementCommand}" HorizontalOptions="Center" />
    </VerticalStackLayout>
</ContentPage>
`
    );

    const bindingContext = mvvm ? 'BindingContext = new ViewModels.MainViewModel();' : '';
    this.writeProjectFile(
      dir,
      'MainPage.xaml.cs',
      `namespace ${appId};

public partial class MainPage : ContentPage
{
    public MainPage()
    {
        InitializeComponent();
${bindingContext ? `        ${bindingContext}\n` : ''}    }
}
`
    );

    if (mvvm) {
      this.writeProjectFile(
        dir,
        'ViewModels/MainViewModel.cs',
        `using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace ${appId}.ViewModels;

public partial class MainViewModel : ObservableObject
{
    [ObservableProperty]
    private int counter;

    [RelayCommand]
    private void Increment() => Counter++;
}
`
      );
    }

    this.writeProjectFile(
      dir,
      'Resources/Styles/Colors.xaml',
      `<?xml version="1.0" encoding="UTF-8" ?>
<?xaml-comp compile="true" ?>
<ResourceDictionary xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
                    xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml">
    <Color x:Key="Primary">#512BD4</Color>
    <Color x:Key="Secondary">#DFD8F7</Color>
    <Color x:Key="Tertiary">#2B0B98</Color>
</ResourceDictionary>
`
    );
    this.writeProjectFile(
      dir,
      'Resources/Styles/Styles.xaml',
      `<?xml version="1.0" encoding="UTF-8" ?>
<?xaml-comp compile="true" ?>
<ResourceDictionary xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
                    xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml">
    <Style TargetType="Button">
        <Setter Property="BackgroundColor" Value="{StaticResource Primary}" />
        <Setter Property="TextColor" Value="White" />
        <Setter Property="CornerRadius" Value="8" />
        <Setter Property="Padding" Value="20,10" />
    </Style>
    <Style TargetType="Label">
        <Setter Property="TextColor" Value="{AppThemeBinding Light=Black, Dark=White}" />
    </Style>
</ResourceDictionary>
`
    );

    this.writeProjectFile(
      dir,
      'Resources/AppIcon/appicon.svg',
      `<svg xmlns="http://www.w3.org/2000/svg" width="456" height="456" viewBox="0 0 456 456">
  <rect width="456" height="456" fill="#512BD4" />
</svg>
`
    );
    this.writeProjectFile(
      dir,
      'Resources/AppIcon/appiconfg.svg',
      `<svg xmlns="http://www.w3.org/2000/svg" width="456" height="456" viewBox="0 0 456 456">
  <circle cx="228" cy="228" r="120" fill="#FFFFFF" />
</svg>
`
    );
    this.writeProjectFile(
      dir,
      'Resources/Splash/splash.svg',
      `<svg xmlns="http://www.w3.org/2000/svg" width="456" height="456" viewBox="0 0 456 456">
  <rect width="456" height="456" fill="#512BD4" />
</svg>
`
    );
    if (android) {
      this.writeProjectFile(
        dir,
        'Platforms/Android/MainActivity.cs',
        `using Android.App;
using Android.Content.PM;

namespace ${appId};

[Activity(Theme = "@style/Maui.SplashTheme", MainLauncher = true, LaunchMode = LaunchMode.SingleTop, ConfigurationChanges = ConfigChanges.ScreenSize | ConfigChanges.Orientation | ConfigChanges.UiMode | ConfigChanges.ScreenLayout | ConfigChanges.SmallestScreenSize | ConfigChanges.Density)]
public class MainActivity : MauiAppCompatActivity
{
}
`
      );
      this.writeProjectFile(
        dir,
        'Platforms/Android/MainApplication.cs',
        `using Android.App;
using Android.Runtime;

namespace ${appId};

[Application]
public class MainApplication : MauiApplication
{
    public MainApplication(IntPtr handle, JniHandleOwnership ownership)
        : base(handle, ownership)
    {
    }

    protected override MauiApp CreateMauiApp() => MauiProgram.CreateMauiApp();
}
`
      );
      this.writeProjectFile(
        dir,
        'Platforms/Android/AndroidManifest.xml',
        `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
	<application android:allowBackup="true" android:icon="@mipmap/appicon" android:supportsRtl="true"></application>
	<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
	<uses-permission android:name="android.permission.INTERNET" />
</manifest>
`
      );
    }

    if (ios) {
      this.writeProjectFile(
        dir,
        'Platforms/iOS/AppDelegate.cs',
        `using Foundation;

namespace ${appId};

[Register("AppDelegate")]
public class AppDelegate : MauiUIApplicationDelegate
{
    protected override MauiApp CreateMauiApp() => MauiProgram.CreateMauiApp();
}
`
      );
      this.writeProjectFile(
        dir,
        'Platforms/iOS/Program.cs',
        `using ObjCRuntime;
using UIKit;

namespace ${appId};

public class Program
{
    static void Main(string[] args)
    {
        UIApplication.Main(args, null, typeof(AppDelegate));
    }
}
`
      );
      this.writeProjectFile(
        dir,
        'Platforms/iOS/Info.plist',
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>LSRequiresIPhoneOS</key>
	<true/>
	<key>UIDeviceFamily</key>
	<array>
		<integer>1</integer>
		<integer>2</integer>
	</array>
	<key>UISupportedInterfaceOrientations</key>
	<array>
		<string>UIInterfaceOrientationPortrait</string>
	</array>
	<key>UISupportedInterfaceOrientations~ipad</key>
	<array>
		<string>UIInterfaceOrientationPortrait</string>
		<string>UIInterfaceOrientationPortraitUpsideDown</string>
		<string>UIInterfaceOrientationLandscapeLeft</string>
		<string>UIInterfaceOrientationLandscapeRight</string>
	</array>
</dict>
</plist>
`
      );
    }

    if (windows) {
      this.writeProjectFile(
        dir,
        'Platforms/Windows/App.xaml',
        `<maui:MauiWinUIApplication
    x:Class="${appId}.WinUI.App"
    xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
    xmlns:maui="using:Microsoft.Maui">
</maui:MauiWinUIApplication>
`
      );
      this.writeProjectFile(
        dir,
        'Platforms/Windows/App.xaml.cs',
        `namespace ${appId}.WinUI;

public partial class App : MauiWinUIApplication
{
    public App()
    {
        InitializeComponent();
    }

    protected override MauiApp CreateMauiApp() => MauiProgram.CreateMauiApp();
}
`
      );
    }

    if (opts.testing) {
      this.writeProjectFile(
        dir,
        `tests/${appId}.Tests/${appId}.Tests.csproj`,
        `<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <IsPackable>false</IsPackable>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.10.0" />
    <PackageReference Include="xunit" Version="2.8.1" />
    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.1" />
  </ItemGroup>

</Project>
`
      );
      this.writeProjectFile(
        dir,
        `tests/${appId}.Tests/ScaffoldTests.cs`,
        `using Xunit;

namespace ${appId}.Tests;

public class ScaffoldTests
{
    [Fact]
    public void Scaffold_is_wired_up()
    {
        Assert.True(true);
    }
}
`
      );
    }

    this.writeProjectFile(
      dir,
      'README.md',
      `# ${name}

${description || 'Cross-platform mobile app built with .NET MAUI.'}

## Requirements

- .NET 8 SDK
- MAUI workload: \`dotnet workload install maui\`
- Android SDK (and/or Xcode on macOS for iOS)

## Run

\`\`\`bash
dotnet build -f ${targets[0] || 'net8.0-android'}
${targets[0] === 'net8.0-android' ? 'dotnet run -f net8.0-android' : `dotnet run -f ${targets[0] || 'net8.0-android'}`}
\`\`\`

## Layout

| Path | Purpose |
| --- | --- |
| \`${appId}.csproj\` | Single-project MAUI app (targets: ${targets.join(', ')}) |
| \`MauiProgram.cs\` | Host builder |
| \`App.xaml\` / \`AppShell.xaml\` | Application shell |
| \`MainPage.xaml\` | First page |
${mvvm ? '| `ViewModels/MainViewModel.cs` | CommunityToolkit.Mvvm view model |\n' : ''}${opts.testing ? '| `tests/` | xUnit test project |\n' : ''}
`
    );

    this.writeGitignore(dir, 'dotnet-maui');
    warnings.push(
      'Install the MAUI workload before building: `dotnet workload install maui`. iOS builds need a macOS host.'
    );
  }

  // ──────────────────────────────────────────────
  //  Monorepo — Microservices
  // ──────────────────────────────────────────────

  /**
   * Deprecated `monorepo-microservices` entry point: a TypeScript Node
   * workspace, so the shape is `monorepoRoot` + one `serviceBody` per service +
   * `compose`.
   *
   * The template predates the architecture rule and still owns its own `docker`
   * flag, so it asks `resolveContainerization` to honour that flag rather than
   * forcing containerization on — existing requests must keep their exact tree.
   * Phase 6 replaces this entry point with `node-ts` + `architecture:
   * microservices`; the three writers stay as they are.
   */
  private async scaffoldMonorepoMicroservices(
    dir: string,
    request: ProjectCreationRequest,
    warnings: string[] = []
  ): Promise<void> {
    fs.mkdirSync(dir, { recursive: true });

    // The monorepo project type carries its own stack select, and a .NET,
    // Laravel or Python tree is a different tree entirely — leave before the
    // npm-workspace writer below runs. A *stack* template fixes the stack
    // itself: `python` + microservices is a Python monorepo even though the
    // request carries no stack option.
    const stack =
      request.templateId === 'monorepo-microservices'
        ? resolveMonorepoStack(request.templateOptions)
        : monorepoStackForTemplate(request.templateId) ?? resolveMonorepoStack(request.templateOptions);
    if (stack !== 'node-ts') {
      await this.scaffoldStackMonorepo(dir, request, warnings, stack);
      return;
    }

    const containerization = resolveContainerization({
      architecture: 'microservices',
      docker: request.templateOptions.docker !== false,
      honourDockerOption: true,
    });
    const context: ScaffoldContext = {
      templateId: 'monorepo-microservices',
      stack: 'node-ts',
      architecture: 'microservices',
      containerization: containerization.policy,
      ci: request.templateOptions.ci === false ? 'none' : 'github',
    };
    const plan = this.monorepoPlan(request);

    // CON-02: contract first. The OpenAPI document and the event schemas are
    // written before any service body, because they are the source of truth
    // the bodies are supposed to implement.
    this.writeContractFiles(dir, plan);

    this.monorepoRoot(dir, context, plan);
    for (const service of plan.services) {
      this.serviceBody(dir, context, plan, service);
    }
    this.compose(dir, context, plan);

    warnings.push(...containerization.warnings);
    if (plan.broker !== 'none' && !context.containerization.dockerEnabled) {
      warnings.push(
        `A ${plan.broker} broker is expected at ${plan.brokerUrl} — start it yourself or regenerate with Docker Compose enabled.`
      );
    }
    if (!plan.gateway) {
      warnings.push('No `gateway` service was requested: clients must call each service port directly.');
    }
  }

  /**
   * Derive the monorepo shape from the wizard request. Everything here is
   * deterministic — same request, same ports, script names and broker URL —
   * which is what makes the golden tree reproducible.
   */
  private monorepoPlan(request: ProjectCreationRequest): MonorepoPlan {
    const {
      projectName: name,
      projectVersion: version,
      projectDescription: description,
      templateOptions: opts,
    } = request;

    const scope = this.slug(name, 'platform');
    const tool = typeof opts.workspaceTool === 'string' ? opts.workspaceTool : 'npm';
    const services = this.parseServiceNames(opts.services);
    const gateway = services.includes('gateway') ? 'gateway' : '';
    const domainServices = services.filter((service) => service !== gateway);
    const withShared = opts.sharedPackage !== false;
    const broker = typeof opts.messageBroker === 'string' ? opts.messageBroker : 'none';
    const k8s = opts.k8s === true;
    const tooling = opts.tooling !== false;

    // Deterministic ports: gateway first, then one port per domain service.
    const ports = new Map<string, number>();
    let nextPort = 4000;
    if (gateway) {
      ports.set(gateway, nextPort);
      nextPort += 1;
    }
    for (const service of domainServices) {
      ports.set(service, nextPort);
      nextPort += 1;
    }
    const portOf = (service: string): number => ports.get(service) ?? 4000;
    const envVar = (service: string): string => `${service.replace(/-/g, '_').toUpperCase()}_URL`;

    const brokerUrl =
      broker === 'nats'
        ? 'nats://localhost:4222'
        : broker === 'kafka'
          ? 'localhost:9092'
          : broker === 'rabbitmq'
            ? 'amqp://guest:guest@localhost:5672'
            : '';

    const isPnpm = tool === 'pnpm';
    const useWorkspacesField = !isPnpm;
    const buildScript = isPnpm
      ? 'pnpm -r --if-present build'
      : tool === 'yarn'
        ? 'yarn workspaces run build'
        : tool === 'turborepo'
          ? 'turbo run build'
          : tool === 'nx'
            ? 'nx run-many -t build'
            : 'npm run build --workspaces --if-present';
    const devScript = isPnpm
      ? 'pnpm -r --parallel --if-present dev'
      : tool === 'yarn'
        ? 'yarn workspaces run dev'
        : tool === 'turborepo'
          ? 'turbo run dev'
          : tool === 'nx'
            ? 'nx run-many -t dev'
            : 'npm run dev --workspaces --if-present';
    const testScript = isPnpm
      ? 'pnpm -r --if-present test'
      : tool === 'yarn'
        ? 'yarn workspaces run test'
        : tool === 'turborepo'
          ? 'turbo run test'
          : tool === 'nx'
            ? 'nx run-many -t test'
            : 'npm run test --workspaces --if-present';
    const installCommand = isPnpm ? 'pnpm install --frozen-lockfile=false' : 'npm install';

    return {
      name,
      version,
      description,
      scope,
      tool,
      services: gateway ? [gateway, ...domainServices] : domainServices,
      gateway,
      domainServices,
      withShared,
      broker,
      k8s,
      tooling,
      isPnpm,
      useWorkspacesField,
      buildScript,
      devScript,
      testScript,
      installCommand,
      sharedName: `@${scope}/shared`,
      brokerUrl,
      portOf,
      envVar,
    };
  }

  /** Workspace root: manifests, tooling config, shared package, root docs + CI. */
  private monorepoRoot(dir: string, ctx: ScaffoldContext, plan: MonorepoPlan): void {
    const {
      name,
      version,
      description,
      scope,
      tool,
      services,
      gateway,
      withShared,
      broker,
      tooling,
      portOf,
      isPnpm,
      useWorkspacesField,
      buildScript,
      devScript,
      testScript,
      installCommand,
      sharedName,
      brokerUrl,
      k8s,
    } = plan;
    const docker = ctx.containerization.dockerEnabled;
    const ci = ctx.ci !== 'none';

    // ── root package.json ─────────────────────────
    const rootDevDependencies: Record<string, string> = {
      typescript: '^5.5.4',
      '@types/node': '^20.14.12',
      tsx: '^4.16.2',
    };
    if (tool === 'turborepo') {
      rootDevDependencies.turbo = '^2.0.9';
    }
    if (tool === 'nx') {
      rootDevDependencies.nx = '^19.5.3';
    }
    if (tooling) {
      Object.assign(rootDevDependencies, { eslint: '^8.57.0', prettier: '^3.3.3', 'typescript-eslint': '^7.17.0' });
    }
    const rootPkg: Record<string, any> = {
      name: scope,
      version: version || '0.1.0',
      description,
      private: true,
      scripts: {
        build: buildScript,
        dev: devScript,
        test: testScript,
        ...(tooling ? { lint: 'eslint . --ext .ts', format: 'prettier --write .' } : {}),
        ...(docker ? { 'docker:up': 'docker compose up --build', 'docker:down': 'docker compose down' } : {}),
      },
      devDependencies: rootDevDependencies,
    };
    if (useWorkspacesField) {
      rootPkg.workspaces = ['services/*', 'packages/*'];
    }
    if (isPnpm) {
      rootPkg.packageManager = 'pnpm@9.6.0';
    }
    if (tool === 'yarn') {
      rootPkg.packageManager = 'yarn@4.3.1';
    }
    this.writeProjectFile(dir, 'package.json', `${JSON.stringify(rootPkg, null, 2)}\n`);

    if (isPnpm) {
      this.writeProjectFile(dir, 'pnpm-workspace.yaml', "packages:\n  - 'services/*'\n  - 'packages/*'\n");
      this.writeProjectFile(dir, '.npmrc', 'strict-peer-dependencies=false\nshamefully-hoist=false\n');
    }

    if (tooling) {
      this.writeProjectFile(
        dir,
        'tsconfig.base.json',
        `${JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2022',
              module: 'commonjs',
              moduleResolution: 'node',
              lib: ['ES2022'],
              strict: true,
              esModuleInterop: true,
              skipLibCheck: true,
              forceConsistentCasingInFileNames: true,
              declaration: true,
              sourceMap: true,
              resolveJsonModule: true,
            },
          },
          null,
          2
        )}\n`
      );
      this.writeProjectFile(
        dir,
        '.eslintrc.json',
        `${JSON.stringify(
          {
            root: true,
            parser: '@typescript-eslint/parser',
            plugins: ['@typescript-eslint'],
            extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
            ignorePatterns: ['dist/', 'node_modules/'],
            env: { node: true, es2022: true },
          },
          null,
          2
        )}\n`
      );
      this.writeProjectFile(dir, '.prettierrc', '{ "singleQuote": true, "printWidth": 100 }\n');
    }

    if (tool === 'turborepo') {
      this.writeProjectFile(
        dir,
        'turbo.json',
        `${JSON.stringify(
          {
            $schema: 'https://turbo.build/schema.json',
            tasks: {
              build: { dependsOn: ['^build'], outputs: ['dist/**'] },
              dev: { cache: false, persistent: true },
              test: { dependsOn: ['build'], outputs: [] },
            },
          },
          null,
          2
        )}\n`
      );
    }
    if (tool === 'nx') {
      this.writeProjectFile(
        dir,
        'nx.json',
        `${JSON.stringify(
          {
            $schema: './node_modules/nx/schemas/nx-schema.json',
            targetDefaults: {
              build: { dependsOn: ['^build'], outputs: ['{projectRoot}/dist'] },
              test: { dependsOn: ['build'] },
            },
            defaultBase: 'main',
          },
          null,
          2
        )}\n`
      );
    }

    // ── shared contracts package ──────────────────
    if (withShared) {
      this.writeProjectFile(
        dir,
        'packages/shared/package.json',
        `${JSON.stringify(
          {
            name: sharedName,
            version: version || '0.1.0',
            private: true,
            main: 'dist/index.js',
            types: 'dist/index.d.ts',
            scripts: { build: 'tsc -p tsconfig.json', dev: 'tsc -p tsconfig.json --watch', test: 'node --test' },
            devDependencies: { typescript: '^5.5.4' },
          },
          null,
          2
        )}\n`
      );
      this.writeProjectFile(
        dir,
        'packages/shared/tsconfig.json',
        `${JSON.stringify(
          {
            extends: tooling ? '../../tsconfig.base.json' : undefined,
            compilerOptions: {
              rootDir: 'src',
              outDir: 'dist',
              ...(tooling ? {} : { target: 'ES2022', module: 'commonjs', strict: true, declaration: true }),
            },
            include: ['src/**/*.ts'],
          },
          null,
          2
        )}\n`
      );
      this.writeProjectFile(
        dir,
        'packages/shared/src/index.ts',
        `export * from './contracts';
${sharedObservabilityBarrelLines().join('\n')}
${sharedResilienceBarrelLines().join('\n')}
${broker !== 'none' ? "export * from './broker';\n" : ''}`
      );
      this.writeProjectFile(
        dir,
        'packages/shared/src/contracts.ts',
        `/** Envelope every cross-service event travels in.
 *
 * Mirrors contracts/events/envelope.v1.json: the JSON Schema is the norm, this
 * interface is the TypeScript view of it. Keep the two in step.
 */
export interface EventEnvelope<T = unknown> {
  eventId: string;
  eventType: EventName;
  timestamp: string;
  source: string;
  correlationId?: string;
  version: number;
  payload: T;
}

/** Standard error body returned by every service. */
export interface ApiError {
  error: string;
  code?: string;
  details?: unknown;
}

/** Every event this system publishes. Schemas live in contracts/events/. */
export const eventNames = {
${plan.domainServices
  .flatMap((serviceName) => defaultEventsFor(serviceName))
  .map((event) => `  ${eventKeyFor(event)}: '${event}',`)
  .join('\n')}
} as const;

export type EventName = (typeof eventNames)[keyof typeof eventNames];
`
      );
      // Observability and lifecycle (§4.2 — CON-03/CON-04): JSON logs, a correlation id,
      // /metrics and the /healthz/{live,ready} split with a SIGTERM drain live in the
      // shared package so every service reports the same shape.
      for (const file of planObservabilityFiles()) {
        this.writeProjectFile(dir, file.path, file.content);
      }
      // Resilience (§4.2 — CON-06): bounded timeouts, jittered backoff, a breaker per
      // dependency and an Idempotency-Key guard, in one module the services import.
      for (const file of planResilienceFiles()) {
        this.writeProjectFile(dir, file.path, file.content);
      }
      if (broker !== 'none') {
        const brokerHint =
          broker === 'nats'
            ? "// nats://localhost:4222 — publish/subscribe with subjects derived from event names"
            : broker === 'kafka'
              ? '// localhost:9092 — one topic per event name, consumer groups per service'
              : '// amqp://guest:guest@localhost:5672 — one exchange per domain, routing key = event name';
        this.writeProjectFile(
          dir,
          'packages/shared/src/broker.ts',
          `/**
 * Message-broker contract shared by every service.
 * Broker: ${broker} ${brokerHint}
 */
export interface BrokerMessage {
  subject: string;
  body: string;
  headers?: Record<string, string>;
}

export interface MessageBroker {
  publish(message: BrokerMessage): Promise<void>;
  subscribe(subject: string, handler: (message: BrokerMessage) => Promise<void> | void): Promise<void>;
  close(): Promise<void>;
}

export const brokerUrl = process.env.BROKER_URL ?? '${brokerUrl}';

/**
 * Wire a concrete client here (nats / kafkajs / amqplib). The interface keeps
 * services independent of the broker library.
 */
export function createBroker(): MessageBroker {
  throw new Error('Wire a ${broker} client in packages/shared/src/broker.ts');
}
`
        );
      }
    }

    // ── CI, architecture and README ───────────────
    if (ci) {
      // One shape of command per workspace tool: the gates must run the
      // workspace's own scripts, not npm's, or a pnpm repo goes red.
      const perWorkspace = (script: string): string =>
        isPnpm
          ? `pnpm -r ${script}`
          : tool === 'yarn'
            ? `yarn workspaces run ${script}`
            : tool === 'turborepo'
              ? `npx turbo run ${script}`
              : tool === 'nx'
                ? `npx nx run-many -t ${script}`
                : `npm run ${script} --workspaces --if-present`;
      this.writeProjectFile(
        dir,
        '.github/workflows/ci.yml',
        planCiWorkflow({
          family: 'node',
          services,
          k8s,
          contractsDir: 'contracts',
          setup: isPnpm
            ? [
                '      - uses: pnpm/action-setup@v4',
                '        with:',
                '          version: 9',
                '      - uses: actions/setup-node@v4',
                '        with:',
                '          node-version: 20',
                '          cache: pnpm',
              ]
            : [
                '      - uses: actions/setup-node@v4',
                '        with:',
                '          node-version: 20',
                `          cache: ${tool === 'yarn' ? 'yarn' : 'npm'}`,
              ],
          install: isPnpm
            ? 'pnpm install --frozen-lockfile=false'
            : tool === 'yarn'
              ? 'yarn install --immutable'
              : 'npm ci',
          typecheck: [perWorkspace('build')],
          test: [perWorkspace('test')],
        })
      );
      this.writeProjectFile(dir, EVENT_SCHEMA_VALIDATOR_PATH, EVENT_SCHEMA_VALIDATOR);
    }

    // Each handbook obligation is a row whose right-hand column is a real symbol, so a
    // rule without an implementation is visible as a gap instead of reading as policy.
    const resilienceRulesDoc = withShared
      ? [
          '## Resilience rules',
          '',
          'Every obligation below is implemented in `packages/shared/src/resilience.ts` — import',
          'it from the shared package; do not hand-roll a timeout or a retry loop.',
          '',
          '| Obligation | Symbol |',
          '| --- | --- |',
          ...resilienceArchitectureRows(),
          '',
        ].join('\n')
      : '';
    this.writeProjectFile(
      dir,
      'ARCHITECTURE.md',
      `# ${name} — microservices architecture

${description || 'Monorepo hosting a set of independently deployable services.'}

## Service catalog

| Service | Folder | Port | Responsibility |
| --- | --- | --- | --- |
${services
  .map(
    (service) =>
      `| ${service} | \`services/${service}\` | ${portOf(service)} | ${
        service === gateway ? 'single entry point, routes traffic to domain services' : 'domain service (owns its own data)'
      } |`
  )
  .join('\n')}

${withShared ? `## Shared contracts

\`packages/${sharedName.split('/')[1]}\` (\`${sharedName}\`) holds DTOs, event envelopes and the health payload. It is
versioned with the repo and consumed as a workspace dependency — never copy types between services.

` : ''}## Rules

1. **One deployable per folder.** A service never imports another service's source; cross-service calls go
   through HTTP or the broker.
2. **Data ownership.** Each service owns its store; no shared database schema.
3. **Contracts first.** Change \`${sharedName}\` before changing producers/consumers, and keep events backward compatible.
4. **Failure isolation.** Every service exposes liveness (\`/healthz/live\`), readiness
   (\`/healthz/ready\`) and a Prometheus \`/metrics\` endpoint. Every outbound call goes
   through the shared resilience kit - never an inline \`setTimeout\` or a bare \`await\`
   on a network call. The rule table below names the symbol behind each obligation.
${broker !== 'none' ? `5. **Async by default.** Use the ${broker} broker for side effects (notifications, projections) and HTTP only for request/response.\n` : ''}${gateway ? `${broker !== 'none' ? '6' : '5'}. **Single entry point.** Clients talk to \`${gateway}\` only; it maps \`${API_PREFIX}/<service>\` prefixes to service URLs (see \`services/${gateway}/src/index.ts\`).\n` : ''}
${resilienceRulesDoc}
## Local development

\`\`\`bash
${installCommand}
${devScript.replace(/^npm run dev/, 'npm run dev')}
\`\`\`
${docker ? '\nOr the whole stack in containers:\n\n```bash\ndocker compose up --build\n```\n' : ''}`
    );

    this.writeProjectFile(
      dir,
      'README.md',
      `# ${name}

${description || 'TypeScript microservices monorepo.'}

Workspace tooling: **${tool}** · Services: ${services.map((service) => `\`${service}\``).join(', ')}
${broker !== 'none' ? `\nMessage broker: **${broker}** (\`${brokerUrl}\`)` : ''}

## Getting started

\`\`\`bash
${installCommand}
${devScript}
\`\`\`
${docker ? '\nEverything in containers:\n\n```bash\ndocker compose up --build\ndocker compose down\n```\n' : ''}
## Layout

\`\`\`
${useWorkspacesField ? 'package.json          workspaces: services/*, packages/*' : 'pnpm-workspace.yaml    workspaces: services/*, packages/*'}
${tooling ? 'tsconfig.base.json    shared TypeScript config\n' : ''}${tool === 'turborepo' ? 'turbo.json            task graph + caching\n' : ''}${tool === 'nx' ? 'nx.json               task graph\n' : ''}services/
${services.map((service) => `  ${service}/           src/index.ts${docker ? ', Dockerfile' : ''}`).join('\n')}
${withShared ? `packages/shared/      contracts, health, ${broker !== 'none' ? 'broker' : 'shared helpers'}\n` : ''}${docker ? 'docker-compose.yml    local stack\n' : ''}${k8s ? 'deploy/k8s/           Kubernetes manifests\n' : ''}ARCHITECTURE.md       service boundaries and rules
\`\`\`

## Scripts

| Script | Does |
| --- | --- |
| \`build\` | ${buildScript} |
| \`dev\` | ${devScript} |
| \`test\` | ${testScript} |
${docker ? '| `docker:up` | `docker compose up --build` |\n| `docker:down` | `docker compose down` |\n' : ''}
Every service listens on its own port and exposes \`${OBSERVABILITY_PATHS.live}\` (liveness),
\`${OBSERVABILITY_PATHS.ready}\` (readiness) and \`${OBSERVABILITY_PATHS.metrics}\` (Prometheus).
`
    );

    this.writeGitignore(dir, 'monorepo-microservices');
  }

  /** One self-contained service: manifest, tsconfig, entrypoint, Dockerfile, k8s. */
  private serviceBody(dir: string, ctx: ScaffoldContext, plan: MonorepoPlan, service: string): void {
    const {
      version,
      scope,
      withShared,
      sharedName,
      tooling,
      isPnpm,
      installCommand,
      broker,
      brokerUrl,
      domainServices,
      gateway,
      k8s,
      portOf,
      envVar,
    } = plan;
    const docker = ctx.containerization.dockerEnabled;
    const isGateway = service === gateway;
    const port = portOf(service);
    const resource = resourceNameFor(service);
    const packageName = `@${scope}/${service}`;
    const serviceDependencies: Record<string, string> = withShared ? { [sharedName]: '*' } : {};

    this.writeProjectFile(
      dir,
      `services/${service}/package.json`,
      `${JSON.stringify(
        {
          name: packageName,
          version: version || '0.1.0',
          private: true,
          main: 'dist/index.js',
          scripts: {
            build: 'tsc -p tsconfig.json',
            dev: 'tsx watch src/index.ts',
            start: 'node dist/index.js',
            test: 'node --test',
          },
          dependencies: serviceDependencies,
          devDependencies: { tsx: '^4.16.2', typescript: '^5.5.4', '@types/node': '^20.14.12' },
        },
        null,
        2
      )}\n`
    );

    this.writeProjectFile(
      dir,
      `services/${service}/tsconfig.json`,
      `${JSON.stringify(
        {
          extends: tooling ? '../../tsconfig.base.json' : undefined,
          compilerOptions: {
            rootDir: 'src',
            outDir: 'dist',
            ...(tooling ? {} : { target: 'ES2022', module: 'commonjs', strict: true, declaration: true }),
          },
          include: ['src/**/*.ts'],
        },
        null,
        2
      )}\n`
    );

    // Observability and lifecycle (§4.2 — CON-03/CON-04). The logger, correlation helper,
    // metrics registry, health/readiness split and drain handler are emitted into
    // packages/shared by observabilityArtifacts.ts; the entrypoint only wires them.
    const observabilityNames = [
      'attachCorrelationId',
      'correlationHeaders',
      'createLogger',
      'healthResponse',
      'HEALTH_LIVE_PATH',
      'HEALTH_LEGACY_PATH',
      'HEALTH_LEGACY_READY_PATH',
      'HEALTH_READY_PATH',
      'installGracefulShutdown',
      'instrumentRoute',
      'logRequest',
      'METRICS_PATH',
      'processStartTimeSeconds',
      'readinessResponse',
      'renderMetrics',
    ].join(',\n  ');
    const healthImport = withShared
      ? 'import {' + '\n  ' + observabilityNames + ',\n' + "} from '" + sharedName + "';"
      : '';
    const healthInline = withShared
      ? 'JSON.stringify(healthResponse(SERVICE, VERSION))'
      : "JSON.stringify({ status: 'ok', service: SERVICE, version: VERSION })";
    const obsPrelude = withShared
      ? [
          '',
          'const logger = createLogger({ service: SERVICE, version: VERSION });',
          'processStartTimeSeconds.set(Math.round(Date.now() / 1000 - process.uptime()));',
        ].join('\n')
      : '';
    const obsRouter = withShared
      ? [
          '',
          '  const requestStartedAt = Date.now();',
          '  const correlationId = attachCorrelationId(req, res);',
          '  logRequest(logger.child({ correlationId }), req);',
          "  res.on('finish', () => {",
          "    instrumentRoute(req.method ?? 'GET', url, res.statusCode, requestStartedAt);",
          '  });',
          '',
          '  if (url === HEALTH_LIVE_PATH || url === HEALTH_LEGACY_PATH) {',
          "    res.writeHead(200, { 'content-type': 'application/json' });",
          '    res.end(JSON.stringify(healthResponse(SERVICE, VERSION)));',
          '    return;',
          '  }',
          '',
          "  if (url === HEALTH_READY_PATH || url === HEALTH_LEGACY_READY_PATH) {",
          '    const payload = readinessResponse(SERVICE, VERSION);',
          "    res.writeHead(payload.status === 'ok' ? 200 : 503, { 'content-type': 'application/json' });",
          '    res.end(JSON.stringify(payload));',
          '    return;',
          '  }',
          '',
          '  if (url === METRICS_PATH) {',
          "    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });",
          '    res.end(renderMetrics());',
          '    return;',
          '  }',
        ].join('\n')
      : '';
    const legacyHealth = withShared
      ? ''
      : [
          "  if (url === '/health' || url === '/ready') {",
          "    res.writeHead(200, { 'content-type': 'application/json' });",
          '    res.end(' + healthInline + ');',
          '    return;',
          '  }',
          '',
        ].join('\n');
    const obsShutdown = withShared ? 'installGracefulShutdown(server, logger);\n' : '';
    const listenLog = withShared
      ? "logger.info('server.listening', { port: PORT });"
      : "console.log('[' + SERVICE + '] listening on http://localhost:' + PORT);";
    const routeListLog = withShared
      ? "for (const [prefix, base] of Object.entries(routes)) {\n    logger.info('gateway.route', { prefix, base });\n  }"
      : "for (const [prefix, base] of Object.entries(routes)) {\n    console.log('  ' + prefix + ' -> ' + base);\n  }";
    const brokerLog = withShared
      ? "logger.info('broker.configured', { brokerUrl: BROKER_URL });"
      : "console.log('[' + SERVICE + '] broker ' + BROKER_URL);";
    const gatewayHeaders = withShared
      ? 'headers: { ...req.headers, host: target.host, ...correlationHeaders(req, correlationId) }'
      : 'headers: { ...req.headers, host: target.host }';

    if (isGateway) {
      const routeLines = domainServices
        .map(
          (target) =>
            `  '${API_PREFIX}/${resourceNameFor(target)}': process.env.${envVar(target)} ?? 'http://localhost:${portOf(target)}',`
        )
        .join('\n');
      // Resilience (§4.2 — CON-06). The kit lives in the shared package, so the gateway
      // only imports it when that package is emitted; without it the proxy keeps its plain
      // pass-through behaviour rather than pretending to enforce a rule it cannot.
      // One import block from the shared package: the gateway needs the breaker, the
      // idempotency key guard and the timeout constant beside the observability names.
      const resilienceNames = [
        'CircuitBreaker',
        'IDEMPOTENCY_HEADER',
        'RESILIENCE_DEFAULTS',
        'idempotencyKeyOf',
      ].join(',\n  ');
      const gatewayImport = withShared
        ? [
            'import {',
            '  ' + observabilityNames + ',\n  ' + resilienceNames + ',',
            "} from '" + sharedName + "';",
          ].join('\n')
        : '';
      const breakerPrelude = withShared
        ? [
            '',
            '/** One breaker per upstream prefix: a sick dependency is cut off, not queued',
            ' * against. */',
            'const breakers = new Map<string, CircuitBreaker>();',
            'const breakerFor = (prefix: string): CircuitBreaker => {',
            '  let breaker = breakers.get(prefix);',
            '  if (!breaker) {',
            '    breaker = new CircuitBreaker(prefix);',
            '    breakers.set(prefix, breaker);',
            '  }',
            '  return breaker;',
            '};',
          ].join('\n')
        : '';
      // A POST without a key cannot be retried safely, so the gateway refuses it rather
      // than let a client retry duplicate the effect further down the chain.
      const keyGuard = withShared
        ? [
            "  if (req.method === 'POST' && !idempotencyKeyOf(req.headers)) {",
            "    res.writeHead(400, { 'content-type': 'application/json' });",
            "    res.end(JSON.stringify({ error: IDEMPOTENCY_HEADER + ' header is required for POST' }));",
            '    return;',
            '  }',
            '',
          ].join('\n')
        : '';
      const breakerAcquire = withShared
        ? [
            '  const breaker = breakerFor(prefix);',
            "  if (breaker.state === 'open') {",
            "    res.writeHead(503, { 'content-type': 'application/json' });",
            "    res.end(JSON.stringify({ error: 'upstream ' + prefix + ' unavailable', reason: 'circuit-open' }));",
            '    return;',
            '  }',
            '',
          ].join('\n')
        : '';
      const breakerObserve = withShared
        ? [
            '      // The body streams straight through, so the breaker is told the outcome',
            '      // directly instead of wrapping the whole exchange in one promise.',
            '      if ((upstreamRes.statusCode ?? 502) >= 500) breaker.recordFailure();',
            '      else breaker.recordSuccess();',
          ].join('\n')
        : '';
      const breakerFailure = withShared ? '    breaker.recordFailure();' : '';
      // A hung upstream would otherwise hold the socket until the client gave up.
      const upstreamTimeout = withShared
        ? [
            '  upstream.setTimeout(RESILIENCE_DEFAULTS.timeoutMs, () => {',
            "    upstream.destroy(new Error('upstream ' + prefix + ' timed out'));",
            '  });',
          ].join('\n')
        : '';
      this.writeProjectFile(
        dir,
        `services/${service}/src/index.ts`,
        `import { createServer, request } from 'node:http';
${gatewayImport}

const SERVICE = 'gateway';
const VERSION = '${version || '0.1.0'}';
const PORT = Number(process.env.PORT ?? ${port});${obsPrelude}

/** Path prefix → upstream service base URL. */
const routes: Record<string, string> = {
${routeLines}
};
${breakerPrelude}

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];${obsRouter}
${legacyHealth}
  const prefix = Object.keys(routes).find((key) => url === key || url.startsWith(key + '/'));
  if (!prefix) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'no route for ' + url }));
    return;
  }

${keyGuard}
${breakerAcquire}
  const target = new URL(routes[prefix] + url);
  const upstream = request(
    {
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: req.method,
      ${gatewayHeaders},
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
${breakerObserve}
    }
  );
  upstream.on('error', (error) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'upstream ' + prefix + ' unavailable', detail: String(error) }));
${breakerFailure}
  });
${upstreamTimeout}
  req.pipe(upstream);
});

${obsShutdown}server.listen(PORT, () => {
  ${listenLog}
  ${routeListLog}
});
`
      );
    } else {
      this.writeProjectFile(
        dir,
        `services/${service}/src/index.ts`,
        `import { createServer } from 'node:http';
${healthImport}

const SERVICE = '${service}';
const VERSION = '${version || '0.1.0'}';
const PORT = Number(process.env.PORT ?? ${port});${obsPrelude}
${broker !== 'none' ? `const BROKER_URL = process.env.BROKER_URL ?? '${brokerUrl}';\n` : ''}
const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];${obsRouter}
${legacyHealth}
  if (url === '${API_PREFIX}/${resource}' || url.startsWith('${API_PREFIX}/${resource}/')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        service: SERVICE,
        items: [],
        contract: 'contracts/openapi/${service}.v1.yaml',
      })
    );
    return;
  }

  if (url === '/' || url === '/${service}') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        service: SERVICE,
        version: VERSION,
        message: '${service} service is up',
      })
    );
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

${obsShutdown}server.listen(PORT, () => {
  ${listenLog}
${broker !== 'none' ? `  ${brokerLog}\n` : ''}});
`
      );
    }

    if (docker) {
      this.writeProjectFile(
        dir,
        `services/${service}/Dockerfile`,
        `# Build from the repo root: docker build -f services/${service}/Dockerfile .
FROM ${BASE_IMAGES.node} AS build
WORKDIR /workspace
COPY package*.json ${isPnpm ? 'pnpm-workspace.yaml ' : ''}./
COPY tsconfig*.json ./
COPY packages ./packages
COPY services ./services
RUN ${installCommand}
RUN ${isPnpm ? `pnpm --filter ${packageName}... build` : `${withShared ? `npm run build --workspace ${sharedName} && ` : ''}npm run build --workspace ${packageName}`}

FROM ${BASE_IMAGES.node} AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=${port}
COPY --from=build /workspace/services/${service}/dist ./dist
COPY --from=build /workspace/node_modules ./node_modules
${hardeningLines('node-alpine', port).join('\n')}
EXPOSE ${port}
CMD ["node", "dist/index.js"]
`
      );
    }

    if (k8s) {
      this.writeProjectFile(dir, 'deploy/k8s/README.md', planK8sReadme({ scope: plan.scope }));
      this.writeProjectFile(
        dir,
        `deploy/k8s/${service}.yaml`,
        planK8sManifests({
          service,
          scope,
          port,
          version: version || '0.1.0',
          kind: 'api',
          family: 'node',
          env: [
            { name: 'PORT', value: String(port) },
            { name: 'LOG_LEVEL', value: 'info' },
            ...(broker !== 'none' ? [{ name: 'BROKER_URL', value: brokerUrl }] : []),
          ],
          secretKeys: ['DATABASE_URL'],
        })
      );
    }
  }

  /** Containerization: the compose file, the root .dockerignore and the env sample. */
  private compose(dir: string, ctx: ScaffoldContext, plan: MonorepoPlan): void {
    const { services, domainServices, gateway, broker, brokerUrl, k8s, portOf, envVar } = plan;

    if (ctx.containerization.compose) {
      const composeServices = services
        .map((service) => {
          const port = portOf(service);
          const targets = domainServices
            .map((target) => `      ${envVar(target)}: http://${target}:${portOf(target)}`)
            .join('\n');
          return `  ${service}:
    build:
      context: .
      dockerfile: services/${service}/Dockerfile
    environment:
      PORT: "${port}"
${broker !== 'none' ? `      BROKER_URL: "${brokerUrl.replace('localhost', 'broker')}"\n` : ''}${service === gateway && targets ? targets + '\n' : ''}    ports:
      - "${port}:${port}"
${broker !== 'none' ? '    depends_on:\n      - broker\n' : ''}`;
        })
        .join('\n');

      const brokerBlock =
        broker === 'nats'
          ? `  broker:
    image: nats:2.10-alpine
    command: ['-js']
    ports:
      - "4222:4222"
`
          : broker === 'kafka'
            ? `  broker:
    image: bitnami/kafka:3.7
    environment:
      KAFKA_CFG_NODE_ID: "1"
      KAFKA_CFG_PROCESS_ROLES: "controller,broker"
      KAFKA_CFG_LISTENERS: "PLAINTEXT://:9092,CONTROLLER://:9093"
      KAFKA_CFG_ADVERTISED_LISTENERS: "PLAINTEXT://broker:9092"
      KAFKA_CFG_CONTROLLER_QUORUM_VOTERS: "1@broker:9093"
      KAFKA_CFG_CONTROLLER_LISTENER_NAMES: "CONTROLLER"
    ports:
      - "9092:9092"
`
            : broker === 'rabbitmq'
              ? `  broker:
    image: rabbitmq:3.13-management-alpine
    ports:
      - "5672:5672"
      - "15672:15672"
`
              : '';

      this.writeProjectFile(
        dir,
        'docker-compose.yml',
        `# Local microservices stack — 'docker compose up --build'
services:
${composeServices}${brokerBlock ? '\n' + brokerBlock : ''}`
      );
    // ZEN-STD-4.3 — one database per service, as a compose overlay.
    this.writeProjectFile(
      dir,
      COMPOSE_DATABASE_PATH,
      planDatabaseOverlay({ services: domainServices })
    );
      this.writeProjectFile(
        dir,
        '.dockerignore',
        `node_modules
**/node_modules
**/dist
.git
.github
${k8s ? 'deploy\n' : ''}`
      );
    }

    this.writeProjectFile(
      dir,
      '.env.example',
      `# Copy to .env and adjust for local runs (compose supplies these automatically)
${services
  .map((service) => `PORT_${service.replace(/-/g, '_').toUpperCase()}=${portOf(service)}`)
  .join('\n')}
${domainServices.map((service) => `${envVar(service)}=http://localhost:${portOf(service)}`).join('\n')}
${broker !== 'none' ? `BROKER_URL=${brokerUrl}\n` : ''}`
    );
  }

  // ──────────────────────────────────────────────
  //  /new-service — grow an existing microservices repo
  // ──────────────────────────────────────────────

  /**
   * Capture every `writeProjectFile()` call instead of writing it.
   *
   * `/new-service` reuses the wizard's own service body and compose generator,
   * so the artifacts have to exist *before* the decision to write (dry run,
   * name clash, unparsable compose). Capturing keeps one implementation of the
   * bodies while still letting the caller preview, refuse and append only.
   */
  private captureWrites(run: () => void): Record<string, string> {
    const previous = this.captureSink;
    const sink: Record<string, string> = {};
    this.captureSink = sink;
    try {
      run();
    } finally {
      this.captureSink = previous;
    }
    return sink;
  }

  private readFileIfPresent(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }
  }

  /** `orders-api` -> `ORDERS_API`; kept local so the module stays pure-friendly. */
  private serviceStem(name: string): string {
    return name.replace(/-/g, '_').toUpperCase();
  }

  /** Stack sniffing for a repo that predates the `.ado-project.json` marker. */
  private sniffMonorepoStack(root: string): MonorepoStackId {
    if (fs.existsSync(path.join(root, 'composer.json'))) {
      return 'php-laravel';
    }
    if (fs.existsSync(path.join(root, 'pyproject.toml')) || fs.existsSync(path.join(root, 'requirements.txt'))) {
      return 'python';
    }
    try {
      if (fs.readdirSync(root).some(entry => entry.endsWith('.sln'))) {
        return 'dotnet';
      }
    } catch {
      // unreadable root — fall through to the Node default
    }
    return 'node-ts';
  }

  /**
   * Resolve the microservices target for `root`.
   *
   * The `services/` folder is what makes a repo microservices (the marker only
   * supplies the stack), so a repo without it is refused with the message that
   * says what to do instead — never half-scaffolded.
   */
  private readServiceTarget(root: string): ServiceTarget | { error: string } {
    const servicesDir = path.join(root, 'services');
    let serviceDirs: string[] = [];
    try {
      serviceDirs = fs
        .readdirSync(servicesDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => entry.name)
        .sort();
    } catch {
      serviceDirs = [];
    }
    if (serviceDirs.length === 0) {
      return {
        error:
          `${root} does not look like a microservices repo — no services/ folder with a service in it. ` +
          'Use /new-project (Monorepo · Microservices) for a new repo, or point at the repo root that has one.',
      };
    }

    const marker = parseProjectMarker(this.readFileIfPresent(path.join(root, PROJECT_MARKER_FILE)));
    const stack: MonorepoStackId = marker ? marker.stack : this.sniffMonorepoStack(root);

    const composeName = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml'].find(candidate =>
      fs.existsSync(path.join(root, candidate))
    );
    const composePath = composeName ? path.join(root, composeName) : null;
    const composeText = composePath ? this.readFileIfPresent(composePath) ?? '' : '';

    const gateway = serviceDirs.includes('gateway') ? 'gateway' : '';
    const domainServices = serviceDirs.filter(service => service !== gateway);
    const broker = /image:\s*\S*rabbitmq/i.test(composeText)
      ? 'rabbitmq'
      : /image:\s*\S*kafka/i.test(composeText)
        ? 'kafka'
        : /image:\s*\S*redis/i.test(composeText)
          ? 'redis'
          : marker?.broker ?? 'none';

    const ports = composeServicePorts(composeText);
    const knownPorts = Object.values(ports).filter(port => Number.isFinite(port) && port > 0);
    const base = stack === 'node-ts' ? 4000 : 8100;
    const nextPort = knownPorts.length > 0 ? Math.max(...knownPorts) + 1 : base + serviceDirs.length;
    const firstService = domainServices[0] ?? gateway;

    return {
      root,
      stack,
      marker,
      services: serviceDirs,
      domainServices,
      gateway,
      broker,
      composePath,
      composeName,
      composeText,
      nextPort,
      knownPorts,
      docker: firstService ? fs.existsSync(path.join(servicesDir, firstService, 'Dockerfile')) : false,
      k8s: fs.existsSync(path.join(root, 'k8s')) || fs.existsSync(path.join(root, 'deploy', 'k8s')),
      sharedPackage: fs.existsSync(path.join(root, 'shared')) || fs.existsSync(path.join(root, 'packages', 'shared')),
    };
  }

  /**
   * Rebuild the Node monorepo plan from what is on disk.
   *
   * `serviceBody()` only needs the plan's *shape* (scope, tooling, ports, the
   * shared package), so every value is read back from the repo rather than
   * guessed: ports from the existing compose file, the workspace tool from the
   * lockfile, the scope from the root package name. A repo whose ports were
   * hand-edited therefore keeps its numbering.
   */
  private nodeTsServicePlan(target: ServiceTarget, service: string): MonorepoPlan {
    const root = target.root;
    let rootPkg: Record<string, any> = {};
    try {
      rootPkg = JSON.parse(this.readFileIfPresent(path.join(root, 'package.json')) ?? '{}');
    } catch {
      rootPkg = {};
    }
    const tool = target.marker?.workspaceTool
      ?? (fs.existsSync(path.join(root, 'pnpm-lock.yaml')) || fs.existsSync(path.join(root, 'pnpm-workspace.yaml'))
        ? 'pnpm'
        : fs.existsSync(path.join(root, 'yarn.lock'))
          ? 'yarn'
          : fs.existsSync(path.join(root, 'turbo.json'))
            ? 'turborepo'
            : fs.existsSync(path.join(root, 'nx.json'))
              ? 'nx'
              : 'npm');
    const isPnpm = tool === 'pnpm';
    const installCommand = isPnpm ? 'pnpm install' : tool === 'yarn' ? 'yarn' : 'npm install';
    const portOf = (name: string): number => {
      const existing = composeServicePorts(target.composeText)[name];
      if (typeof existing === 'number') {
        return existing;
      }
      const index = [target.gateway, ...target.domainServices].filter(Boolean).indexOf(name);
      return index < 0 ? target.nextPort : 4000 + index;
    };
    const envVar = (name: string): string => `${this.serviceStem(name)}_URL`;
    const services = target.gateway ? [target.gateway, ...target.domainServices, service] : [...target.domainServices, service];

    return {
      name: typeof rootPkg.name === 'string' && rootPkg.name ? rootPkg.name : path.basename(root),
      version: typeof rootPkg.version === 'string' && rootPkg.version ? rootPkg.version : '0.1.0',
      description: typeof rootPkg.description === 'string' && rootPkg.description ? rootPkg.description : `${service} service`,
      scope: typeof rootPkg.name === 'string' && rootPkg.name.replace(/^@/, '').split('/')[0]
        ? rootPkg.name.replace(/^@/, '').split('/')[0]
        : path.basename(root),
      tool,
      services,
      gateway: target.gateway,
      domainServices: [...target.domainServices, service],
      withShared: target.sharedPackage,
      broker: target.broker,
      k8s: target.k8s,
      tooling: fs.existsSync(path.join(root, 'tsconfig.json')),
      isPnpm,
      useWorkspacesField: !isPnpm,
      buildScript: 'build',
      devScript: 'dev',
      testScript: 'test',
      installCommand,
      sharedName: target.sharedPackage ? `${path.basename(root)}-shared` : '',
      brokerUrl:
        target.broker === 'rabbitmq'
          ? 'amqp://guest:guest@broker:5672'
          : target.broker === 'kafka'
            ? 'broker:9092'
            : target.broker === 'redis'
              ? 'redis://broker:6379'
              : '',
      portOf,
      envVar,
    };
  }

  /** The env keys a generated single-service `.env.example` declares for `service`. */
  private serviceEnvKeysFromExample(example: string, service: string): string[] {
    const stem = this.serviceStem(service);
    return example
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .filter(line => line.startsWith(`${stem}_`) || line.startsWith(`PORT_${stem}=`))
      .map(line => line.replace(/\s+$/, ''));
  }

  /**
   * Add one service to an existing microservices repo — the single
   * implementation behind `/new-service`, the palette command and the
   * `add_service` tool.
   *
   * Append-only by construction: the service folder must not exist, and every
   * other target (compose, `.env.example`, README, architecture doc, CI matrix)
   * is *patched* through a helper that returns `null` instead of reformatting a
   * file it cannot parse. Never re-inits git, never installs, never rewrites a
   * file wholesale.
   */
  addService(request: AddServiceRequest): AddServiceResult {
    const root = path.resolve(request.workspaceRoot ?? '');
    const target = this.readServiceTarget(root);
    if ('error' in target) {
      return { ok: false, error: target.error, warnings: [] };
    }

    const existing = Array.from(new Set([...target.services, ...composeServiceNames(target.composeText)]));
    const nameError = serviceNameError(request.name, existing);
    if (nameError) {
      return { ok: false, error: nameError, warnings: [] };
    }
    const service = request.name;
    const kind = normalizeServiceKind(request.kind);
    const warnings: string[] = [];
    if (kind === 'worker' && !serviceSupportsWorker(target.stack)) {
      return {
        ok: false,
        error:
          `the ${target.stack} stack has no worker entrypoint — /new-service can only add an api there. ` +
          'A worker would be a second service that publishes no port and never runs.',
        warnings: [],
      };
    }

    // 1. plan the body — captured, nothing on disk yet
    let bodyFiles: Record<string, string> = {};
    let composeBlock = '';
    let envKeys: string[] = [];
    try {
      if (target.stack === 'node-ts') {
        const plan = this.nodeTsServicePlan(target, service);
        const ctx = {
          containerization: { compose: !!target.composePath, dockerEnabled: target.docker },
        } as unknown as ScaffoldContext;
        const captured = this.captureWrites(() => {
          this.serviceBody(root, ctx, plan, service);
          this.compose(root, ctx, plan);
        });
        bodyFiles = Object.fromEntries(
          Object.entries(captured).filter(([relPath]) => relPath.startsWith(`services/${service}/`))
        );
        composeBlock = extractComposeServiceBlock(captured['docker-compose.yml'] ?? '', service) ?? '';
        envKeys = this.serviceEnvKeysFromExample(captured['.env.example'] ?? '', service);
      } else {
        const tree = planMonorepoTree(target.stack, {
          projectName: path.basename(root),
          description: request.description ?? `${service} service`,
          version: '0.1.0',
          services: [...target.domainServices, service],
          gateway: target.gateway,
          broker: target.broker,
          sharedPackage: target.sharedPackage,
          containerization: !!target.composePath,
        });
        bodyFiles = Object.fromEntries(
          Object.entries(tree).filter(([relPath]) => relPath.startsWith(`services/${service}/`))
        );
        composeBlock = extractComposeServiceBlock(tree['docker-compose.yml'] ?? '', service) ?? '';
        envKeys = this.serviceEnvKeysFromExample(tree['.env.example'] ?? '', service);
      }
    } catch (error) {
      return {
        ok: false,
        error: `could not plan ${service}: ${error instanceof Error ? error.message : String(error)}`,
        warnings,
      };
    }

    if (Object.keys(bodyFiles).length === 0) {
      return {
        ok: false,
        error: `the ${target.stack} generator produced no files for "${service}" — the service folder was left untouched.`,
        warnings,
      };
    }

    if (kind === 'worker') {
      for (const [relPath, content] of Object.entries(workerEntrypointFiles(target.stack, service))) {
        bodyFiles[relPath] = content;
      }
      if (composeBlock) {
        composeBlock = asWorkerComposeBlock(composeBlock, target.stack, service);
      }
      envKeys = [];
    }

    const port = composeServicePorts(composeBlock)[service] ?? target.nextPort;
    if (target.knownPorts.includes(port)) {
      warnings.push(
        `port ${port} is already published by another service in ${target.composeName} — the generated entry keeps the stack's numbering; renumber it if it clashes.`
      );
    }

    // 2. patches — every helper returns null rather than reformatting
    const writes: Array<{ relPath: string; content: string }> = Object.entries(bodyFiles).map(([relPath, content]) => ({
      relPath,
      content,
    }));
    const patched: string[] = [];

    if (target.composePath && composeBlock) {
      const next = appendComposeService(target.composeText, service, composeBlock);
      if (next === null) {
        warnings.push(`could not append ${service} to ${target.composeName} — add the entry by hand (see the preview).`);
      } else {
        writes.push({ relPath: target.composeName as string, content: next });
        patched.push(target.composeName as string);
      }
    } else if (!target.composePath) {
      warnings.push('no docker-compose.yml found — the service was scaffolded without a compose entry.');
    }

    const envPath = path.join(root, '.env.example');
    const envText = this.readFileIfPresent(envPath);
    if (envKeys.length > 0) {
      if (envText === null) {
        warnings.push('.env.example is missing — the new env keys are listed in the summary instead.');
      } else {
        const next = appendEnvKeys(envText, envKeys);
        if (next !== envText) {
          writes.push({ relPath: '.env.example', content: next });
          patched.push('.env.example');
        }
      }
    }

    const readmeText = this.readFileIfPresent(path.join(root, 'README.md'));
    if (readmeText !== null) {
      const row = appendReadmeServiceRow(readmeText, [`\`${service}\``, kind, String(port), request.description ?? '']);
      if (row === null) {
        warnings.push('README.md has no service table to extend — add a row by hand if it keeps one.');
      } else if (row !== readmeText) {
        writes.push({ relPath: 'README.md', content: row });
        patched.push('README.md');
      }
    }

    const archRelPath = ['docs/architecture.md', 'ARCHITECTURE.md', 'docs/ARCHITECTURE.md'].find(candidate =>
      fs.existsSync(path.join(root, candidate))
    );
    if (archRelPath) {
      const archText = this.readFileIfPresent(path.join(root, archRelPath));
      if (archText !== null) {
        const next = appendArchitectureService(archText, service, kind, target.stack, port);
        if (next !== null && next !== archText) {
          writes.push({ relPath: archRelPath, content: next });
          patched.push(archRelPath);
        }
      }
    }

    const workflowsDir = path.join(root, '.github', 'workflows');
    try {
      for (const file of fs.readdirSync(workflowsDir).filter(entry => /\.ya?ml$/.test(entry))) {
        const relPath = `.github/workflows/${file}`;
        const ciText = this.readFileIfPresent(path.join(workflowsDir, file));
        if (ciText === null) {
          continue;
        }
        const next = appendCiMatrixService(ciText, service);
        if (next !== null && next !== ciText) {
          writes.push({ relPath, content: next });
          patched.push(relPath);
          break;
        }
      }
    } catch {
      // no workflows folder — nothing to extend
    }

    // 3. contracts — CON-02. A service is not real until its contract exists.
    //    Only missing files are written: a contract a team has since edited is
    //    never overwritten by a later `/new-service` run, and the folder README
    //    is left alone because a single-service table would misdescribe it.
    const contractFiles = planContractFiles({
      projectName: service,
      services: [
        {
          name: service,
          port,
          resource: resourceNameFor(service),
          events: defaultEventsFor(service),
        },
      ],
    });
    for (const [relPath, content] of Object.entries(contractFiles)) {
      if (relPath.endsWith('README.md')) continue;
      // A worker has no HTTP surface, so an OpenAPI document would describe
      // routes it does not serve. Its event schemas are still stamped.
      if (kind === 'worker' && relPath.startsWith(`${CONTRACTS_DIR}/openapi/`)) continue;
      if (fs.existsSync(`${root}/${relPath}`)) {
        warnings.push(`contract ${relPath} already exists — left untouched; extend it by hand if ${service} adds to it.`);
        continue;
      }
      writes.push({ relPath, content });
    }

    let markerWritten = false;
    if (!target.marker) {
      const marker: ProjectMarker = { stack: target.stack, architecture: 'microservices', serviceKind: kind };
      if (target.broker !== 'none') {
        marker.broker = target.broker;
      }
      writes.push({ relPath: PROJECT_MARKER_FILE, content: serializeProjectMarker(marker) });
      markerWritten = true;
    }

    const files = writes.map(write => write.relPath);

    if (request.dryRun) {
      return {
        ok: true,
        dryRun: true,
        service,
        stack: target.stack,
        kind,
        port,
        files,
        written: [],
        patched: [],
        warnings,
        envKeys,
        preview: { compose: composeBlock, files },
        postCreateSteps: this.servicePostCreateSteps(target.stack, service, kind, port),
      };
    }

    for (const write of writes) {
      this.writeProjectFile(root, write.relPath, write.content);
    }
    if (markerWritten) {
      patched.push(PROJECT_MARKER_FILE);
    }

    return {
      ok: true,
      service,
      stack: target.stack,
      kind,
      port,
      files,
      written: files.filter(relPath => !patched.includes(relPath)),
      patched,
      warnings,
      envKeys,
      markerWritten,
      postCreateSteps: this.servicePostCreateSteps(target.stack, service, kind, port),
    };
  }

  /** The two commands that make a freshly added service run. */
  private servicePostCreateSteps(
    stack: MonorepoStackId,
    service: string,
    kind: ServiceKind,
    port: number
  ): PostCreateStep[] {
    const install =
      stack === 'node-ts'
        ? 'npm install'
        : stack === 'python'
          ? 'pip install -e .'
          : stack === 'dotnet'
            ? 'dotnet build'
            : 'composer install';
    return [
      {
        label: `Install ${service} dependencies`,
        command: `cd services/${service} && ${install}`,
        detail: 'The service is a workspace member; this resolves its own manifest.',
      },
      {
        label: kind === 'worker' ? `Start the ${service} worker` : `Run ${service}`,
        command: `docker compose up ${service}`,
        detail:
          kind === 'worker'
            ? 'Consumes the broker — a worker publishes no port.'
            : `Serves on http://localhost:${port}.`,
      },
    ];
  }

  /**
   * The monorepo layout for a non-TypeScript stack.
   *
   * The plan — services, gateway, broker, containerization — is resolved the
   * same way the Node writer resolves it, and the tree comes from
   * `planMonorepoTree`, so a .NET or Laravel monorepo is data instead of a
   * third copy of this writer. Container files are dropped when the wizard
   * opted out of containerization, which the README explains.
   */
  private async scaffoldStackMonorepo(
    dir: string,
    request: ProjectCreationRequest,
    warnings: string[],
    stack: MonorepoStackId
  ): Promise<void> {
    fs.mkdirSync(dir, { recursive: true });

    const containerization = resolveContainerization({
      architecture: 'microservices',
      docker: request.templateOptions.docker !== false,
      honourDockerOption: true,
    });
    const serviceNames = this.parseServiceNames(request.templateOptions.services);
    const gateway = request.templateOptions.gateway === false ? '' : 'gateway';
    const domainServices = serviceNames.filter((name) => name !== gateway);
    const plan: MonorepoTreePlan = {
      projectName: request.projectName,
      description: request.projectDescription ?? '',
      version: request.projectVersion || '0.1.0',
      services: domainServices.length > 0 ? domainServices : ['api', 'worker'],
      gateway,
      broker: String(request.templateOptions.messageBroker ?? 'none'),
      sharedPackage: request.templateOptions.sharedPackage !== false,
      containerization: containerization.policy.dockerEnabled,
    };

    for (const [relPath, content] of Object.entries(planMonorepoTree(stack, plan))) {
      const isContainerFile = /(^|\/)(Dockerfile|docker-compose\.yml)$/.test(relPath);
      if (isContainerFile && !plan.containerization) {
        continue;
      }
      this.writeProjectFile(dir, relPath, content);
    }

    if (!plan.containerization) {
      warnings.push(
        `Containerization is disabled, so this ${stack} monorepo ships no Dockerfiles and no docker-compose.yml — run it with the stack tooling listed in README.md.`
      );
    }

    this.writeGitignore(dir, gitignoreLabelForStack(stack));
  }

  /**
   * Promote containerization on every project type.
   *
   * Only `node-ts` and `dotnet-webapi` used to write a Dockerfile, so picking
   * any other stack silently produced a project that could not be containerized
   * from the wizard. The stack decides now: unless the wizard opted out (or the
   * template writer already emitted a tailored Dockerfile), the stack container
   * setup is written. Mobile/documentation/empty templates are a no-op.
   */
  private applyContainerization(dir: string, request: ProjectCreationRequest): void {
    if (!supportsContainerization(request.templateId)) {
      return;
    }
    if (request.templateOptions.docker === false) {
      return;
    }
    if (fs.existsSync(path.join(dir, 'Dockerfile'))) {
      return;
    }
    const files = planContainerFiles(request.templateId, {
      projectName: request.projectName,
      version: request.projectVersion,
    });
    for (const [relPath, content] of Object.entries(files)) {
      this.writeProjectFile(dir, relPath, content);
    }
  }

  private async scaffoldEmpty(
    dir: string,
    request: ProjectCreationRequest
  ): Promise<void> {
    const { projectName: name, projectDescription: description, templateOptions: opts } = request;
    fs.mkdirSync(dir, { recursive: true });

    if (opts.readme) {
      fs.writeFileSync(
        path.join(dir, 'README.md'),
        `# ${name}\n\n${description || 'A new project.'}\n`
      );
    }

    if (opts.gitignore) {
      this.writeGitignore(dir, 'empty');
    }

    if (opts.license && opts.license !== 'None') {
      const year = new Date().getFullYear();
      if (opts.license === 'MIT') {
        fs.writeFileSync(
          path.join(dir, 'LICENSE'),
          `MIT License\n\nCopyright (c) ${year}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n`
        );
      } else if (opts.license === 'Apache-2.0') {
        fs.writeFileSync(
          path.join(dir, 'LICENSE'),
          `Apache License\nVersion 2.0, January 2004\nhttp://www.apache.org/licenses/\n\nCopyright ${year}\n\nLicensed under the Apache License, Version 2.0 (the "License");\nyou may not use this file except in compliance with the License.\nYou may obtain a copy of the License at\n\n    http://www.apache.org/licenses/LICENSE-2.0\n\nUnless required by applicable law or agreed to in writing, software\ndistributed under the License is distributed on an "AS IS" BASIS,\nWITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.\nSee the License for the specific language governing permissions and\nlimitations under the License.\n`
        );
      } else if (opts.license === 'GPL-3.0') {
        fs.writeFileSync(
          path.join(dir, 'LICENSE'),
          `GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n\nCopyright (C) ${year}\n\nThis program is free software: you can redistribute it and/or modify\nit under the terms of the GNU General Public License as published by\nthe Free Software Foundation, either version 3 of the License, or\n(at your option) any later version.\n`
        );
      }
    }
  }

  // ──────────────────────────────────────────────
  //  .gitignore templates
  // ──────────────────────────────────────────────
  /**
   * Write the generated test-automation suite, when the template carries the
   * `testAutomation` option group and at least one suite is switched on.
   *
   * The module is pure: it returns files, ignore lines, warnings and
   * post-create steps and writes nothing, so every byte of I/O stays here.
   * `prefix` is '' for the standalone template (the suite IS the project) and
   * 'tests' for an app template, where the suite is a sibling of the app.
   */
  private appendTestAutomationSuite(
    dir: string,
    request: ProjectCreationRequest,
    warnings: string[],
    postCreateSteps: PostCreateStep[],
    prefix = 'tests'
  ): void {
    // Only a template whose catalogue entry actually offers the group may get a
    // suite. `isSuiteEnabled` reads an ABSENT option as enabled and the wizard
    // always sends defaults, so undefined options only happen for templates
    // without the group — and every other template's tree is pinned by a golden
    // fixture under src/test/suite/services/fixtures/.
    const template = PROJECT_TEMPLATES.find((t) => t.id === request.templateId);
    if (!template?.options.some((o) => o.id === 'e2e')) {
      return;
    }
    const options = (request.templateOptions ?? {}) as unknown as TestAutomationOptions;
    if (prefix !== '' && !isSuiteEnabled(request.templateOptions ?? {})) {
      return; // the group is offered but every suite is switched off
    }
    const suite = scaffoldTestAutomationSuite(options);
    for (const file of suite.files) {
      this.writeProjectFile(dir, prefix ? `${prefix}/${file.path}` : file.path, file.content);
    }
    this.appendIgnoreLines(dir, suite.ignoreLines);
    warnings.push(...suite.warnings);
    postCreateSteps.push(...suite.postCreateSteps);
  }

  /**
   * Merge lines into the existing .gitignore instead of rewriting it: the
   * template's own writer owns that file, this only adds what the generated
   * suite needs (docs/project-scaffolding.md F4). Existing lines are never
   * touched, so a template's ignore set keeps its exact bytes.
   */
  private appendIgnoreLines(dir: string, lines: readonly string[]): void {
    if (lines.length === 0) return;
    const file = path.join(dir, '.gitignore');
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const present = new Set(existing.split(/\r?\n/).map(line => line.trim()));
    const missing = lines.filter(line => !present.has(line.trim()));
    if (missing.length === 0) return;
    const glue = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(file, `${existing}${glue}${missing.join('\n')}\n`, 'utf8');
  }

  /**
   * Write the `.gitignore` for a label.
   *
   * The label space is typed (`src/shared/gitignoreTemplates.ts`), so an unknown
   * template cannot reach this method and there is no default body to fall back
   * to — the old `|| node_modules/` arm silently wrote the wrong file
   * (docs/project-scaffolding.md, F2).
   */
  private writeGitignore(dir: string, label: GitignoreLabel): void {
    fs.writeFileSync(path.join(dir, '.gitignore'), gitignoreContent(label));
  }

  /** RFC-4122-ish v4 GUID for generated .sln files (no crypto import needed). */
  private newGuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  // ──────────────────────────────────────────────
  //  Git operations
  // ──────────────────────────────────────────────
  private run(cmd: string, args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { cwd }, (err: any, stdout: string, stderr: string) => {
        if (err) {
          const detail = ((stderr || '').toString() || err.message || '').trim();
          reject(new Error(detail || String(err)));
        } else {
          resolve((stdout || '').toString().trim());
        }
      });
    });
  }

  private async initGit(dir: string, branchName?: string): Promise<void> {
    const branch = (branchName || '').trim() || 'main';
    try {
      // git init -b needs git >= 2.28 (2020) — the common case.
      await this.run('git', ['init', '-b', branch], dir);
    } catch {
      // Older git: plain init, then move the unborn HEAD onto the branch.
      await this.run('git', ['init'], dir);
      await this.run('git', ['checkout', '-b', branch], dir).catch(() => undefined);
    }
  }

  /**
   * CON-02 — write the contract-first artifacts for a monorepo plan.
   *
   * One OpenAPI 3.1 document per domain service plus one JSON Schema per event,
   * under `contracts/`. The gateway is excluded: it forwards the `/api/v1`
   * prefix verbatim to the owning service, so its surface is their union.
   */
  private writeContractFiles(dir: string, plan: MonorepoPlan): void {
    const services: ServiceContract[] = plan.domainServices.map((service) => ({
      name: service,
      port: plan.portOf(service),
      resource: resourceNameFor(service),
      events: defaultEventsFor(service),
    }));

    const files = planContractFiles({
      projectName: plan.name,
      description: plan.description,
      services,
    });

    for (const [relativePath, content] of Object.entries(files)) {
      this.writeProjectFile(dir, relativePath, content);
    }
  }

  private async createInitialCommit(dir: string, projectName: string): Promise<void> {
    await this.run('git', ['add', '.'], dir);
    await this.run('git', ['commit', '-m', `Initial commit: ${projectName}`], dir);
  }
}

/** The microservices repo `/new-service` resolved before writing anything. */
export interface ServiceTarget {
  root: string;
  stack: MonorepoStackId;
  /** `null` when the repo predates `.ado-project.json` and was sniffed. */
  marker: ProjectMarker | null;
  /** Every folder under `services/`, sorted. */
  services: string[];
  /** `services` minus the gateway. */
  domainServices: string[];
  /** The gateway folder, or '' when the repo has none. */
  gateway: string;
  broker: string;
  composePath: string | null;
  composeName?: string;
  composeText: string;
  /** First port above everything already published, or the stack base. */
  nextPort: number;
  /** Ports already published in the compose file. */
  knownPorts: number[];
  docker: boolean;
  k8s: boolean;
  sharedPackage: boolean;
}

/** Input of `ProjectCreationService.addService()`. */
export interface AddServiceRequest {
  /** Repo root — the folder that owns `services/`. */
  workspaceRoot: string;
  name: string;
  /** `api` (default) or `worker` — a worker publishes no port. */
  kind?: ServiceKind;
  description?: string;
  /** Plan and preview only; nothing is written. */
  dryRun?: boolean;
}

/** Result of `ProjectCreationService.addService()`. */
export interface AddServiceResult {
  ok: boolean;
  error?: string;
  service?: string;
  stack?: MonorepoStackId;
  kind?: ServiceKind;
  port?: number;
  /** Every file the operation created or patched. */
  files?: string[];
  /** Files that did not exist before. */
  written?: string[];
  /** Existing files that were extended in place. */
  patched?: string[];
  warnings: string[];
  /** Env keys for the new service, when `.env.example` had no home for them. */
  envKeys?: string[];
  markerWritten?: boolean;
  dryRun?: boolean;
  preview?: { compose: string; files: string[] };
  postCreateSteps?: PostCreateStep[];
}
