import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { logger } from '../services/logger';
import { ProjectCreationRequest, PROJECT_TEMPLATES } from '../webview-ui/src/components/ProjectCreationWizard/types';

export class ProjectCreationService {
  constructor(private context: vscode.ExtensionContext) {}

  /**
   * Create a new project based on the wizard request.
   * Handles directory creation, template scaffolding, git init, and initial commit.
   */
  async createProject(
    request: ProjectCreationRequest
  ): Promise<{ success: boolean; path: string; error?: string }> {
    try {
      // Guard against empty targetPath (webview sends '' expecting host resolution)
      if (!request.targetPath) {
        return {
          success: false,
          path: '',
          error: 'No target path specified',
        };
      }
      const projectDir = path.join(request.targetPath, request.projectName);

      logger.info(`ProjectCreation: creating project "${request.projectName}" with template "${request.templateId}"`);

      // Ensure target path exists
      if (!fs.existsSync(request.targetPath)) {
        fs.mkdirSync(request.targetPath, { recursive: true });
      }

      // Check if project directory already exists
      if (fs.existsSync(projectDir)) {
        logger.warn(`ProjectCreation: directory "${projectDir}" already exists`);
        return {
          success: false,
          path: projectDir,
          error: `Directory "${request.projectName}" already exists at ${request.targetPath}`,
        };
      }

      // Scaffold files based on template
      await this.scaffoldByTemplate(projectDir, request);

      // Initialize git if requested
      if (request.gitInit) {
        await this.initGit(projectDir);
      }

      // Create initial commit if requested
      if (request.gitInitialCommit && request.gitInit) {
        await this.createInitialCommit(projectDir, request.projectName);
      }

      logger.info(`ProjectCreation: project "${request.projectName}" created successfully at ${projectDir}`);
      return {
        success: true,
        path: projectDir,
      };
    } catch (err) {
      logger.error(`ProjectCreation: failed to create project`, err);
      return {
        success: false,
        path: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Route to the appropriate scaffolding method based on template ID.
   */
  private async scaffoldByTemplate(
    dir: string,
    request: ProjectCreationRequest
  ): Promise<void> {
    const template = PROJECT_TEMPLATES.find((t) => t.id === request.templateId);
    if (!template) {
      throw new Error(`Unknown template: ${request.templateId}`);
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
      case 'empty':
        await this.scaffoldEmpty(dir, request);
        break;
      default:
        throw new Error(`No scaffolder for template: ${request.templateId}`);
    }
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
        `FROM node:20-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci\nCOPY . .\nRUN npm run build\nCMD ["node", "dist/index.js"]\n`
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
      `\nMicrosoft Visual Studio Solution File, Format Version 12.00\n# Visual Studio Version 17\nVisualStudioVersion = 17.0.31903.59\nMinimumVisualStudioVersion = 10.0.40219.1\nProject("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "${name}", "${name}.csproj", "{GUID-HERE}"\nEndProject\nGlobal\n\tGlobalSection(SolutionConfigurationPlatforms) = preSolution\n\t\tDebug|Any CPU = Debug|Any CPU\n\t\tRelease|Any CPU = Release|Any CPU\n\tEndGlobalSection\nEndGlobal\n`
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
        `FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS base\nWORKDIR /app\nEXPOSE 80\nEXPOSE 443\n\nFROM mcr.microsoft.com/dotnet/sdk:8.0 AS build\nWORKDIR /src\nCOPY . .\nRUN dotnet restore\nRUN dotnet publish -c Release -o /app/publish\n\nFROM base AS final\nWORKDIR /app\nCOPY --from=build /app/publish .\nENTRYPOINT ["dotnet", "${name}.dll"]\n`
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
      `import type { Metadata } from 'next';\n\nexport const metadata: Metadata = {\n  title: '${name}',\n  description: '${description || ''}',\n};\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}\n`
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
      pkg.devDependencies.prisma = '^5.0.0';
      fs.writeFileSync(path.join(dir, 'prisma', 'schema.prisma'), `// Prisma schema\n\n datasource db {\n   provider = "postgresql"\n   url      = env("DATABASE_URL")\n }\n\n generator client {\n   provider = "prisma-client-js"\n }\n`);
    }

    this.writeGitignore(dir, 'node-ts');
  }

  // ──────────────────────────────────────────────
  //  Empty Project
  // ──────────────────────────────────────────────
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
  private writeGitignore(dir: string, templateId: string): void {
    const gitignores: Record<string, string> = {
      'node-ts': 'node_modules/\ndist/\n.env\n.env.local\n',
      'node-js': 'node_modules/\n.env\n.env.local\n',
      python: '__pycache__/\n*.pyc\n.env\nvenv/\n.venv/\n*.egg-info/\n',
      'php-laravel': '/vendor/\n.env\n.env.backup\n.phpunit.result.cache\nHomestead.json\nHomestead.yaml\nauth.json\nnpm-debug.log\nyarn-error.log\n/.fleet\n/.idea\n/.vscode\n',
      php: '/vendor/\ncomposer.lock\n.phpunit.result.cache\n',
      dotnet: '/bin/\n/obj/\n/user/\n*.user\n*.suo\n*.userosscache\n*.sln.docstates\n',
      empty: '',
    };

    const content = gitignores[templateId] || 'node_modules/\n';
    if (content) {
      fs.writeFileSync(path.join(dir, '.gitignore'), content);
    }
  }

  // ──────────────────────────────────────────────
  //  Git operations
  // ──────────────────────────────────────────────
  private async initGit(dir: string): Promise<void> {
    const { execFile } = require('child_process');
    await new Promise<void>((resolve, reject) => {
      execFile('git', ['init'], { cwd: dir }, (err: any) =>
        err ? reject(err) : resolve()
      );
    });
  }

  private async createInitialCommit(dir: string, projectName: string): Promise<void> {
    const { execFile } = require('child_process');

    const exec = (cmd: string, args: string[]): Promise<void> =>
      new Promise((resolve, reject) => {
        execFile(cmd, args, { cwd: dir }, (err: any) =>
          err ? reject(err) : resolve()
        );
      });

    await exec('git', ['add', '.']);
    await exec('git', ['commit', '-m', `Initial commit: ${projectName}`]);
  }
}
