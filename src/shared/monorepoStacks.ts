/**
 * The stack catalogue behind the "Monorepo (Microservices)" project type.
 *
 * Why this module exists: the wizard offered exactly one monorepo flavour — a
 * TypeScript/npm workspace — so picking the project type silently forced Node
 * on a .NET, Laravel or Python team. The stack is now a first-class value the
 * wizard renders, the host dispatches on and the tree planners below switch on.
 *
 * It mirrors `src/shared/architectureStyles.ts`: pure data + pure functions,
 * no `fs`, no `vscode`. The planners return a `path -> content` map and never
 * touch the disk, so the host owns all I/O (and the tests need no temp dir).
 */

export type MonorepoStackId = 'node-ts' | 'dotnet' | 'php-laravel' | 'python';

export interface MonorepoStackDescriptor {
  id: MonorepoStackId;
  label: string;
  description: string;
  /**
   * Wizard templates that build this stack once their architecture is
   * `microservices`. `node-ts` keeps the legacy workspace writer.
   */
  templates: readonly string[];
  /** Workspace manifest at the repository root. */
  manifest: string;
  install: string;
  build: string;
  test: string;
  /** Base image the per-service Dockerfiles derive from. */
  image: string;
}

import { BASE_IMAGES, CURL_INSTALL_LINES, hardeningLines } from './containerHardening';
import { OBSERVABILITY_PATHS } from './observabilityArtifacts';
import { API_PREFIX, defaultEventsFor, planContractFiles, resourceNameFor } from './contractArtifacts';
import type { ContractPlan } from './contractArtifacts';

export const MONOREPO_STACKS: readonly MonorepoStackDescriptor[] = [
  {
    id: 'node-ts',
    label: 'Node.js (TypeScript)',
    description: 'npm/pnpm workspaces, one package per service, tsc build',
    templates: ['node-ts', 'node-js'],
    manifest: 'package.json',
    install: 'npm install',
    build: 'npm run build',
    test: 'npm test',
    image: BASE_IMAGES.node,
  },
  {
    id: 'dotnet',
    label: '.NET (C#)',
    description: 'One solution, a csproj per service, ASP.NET Core minimal APIs',
    templates: ['dotnet-webapi'],
    manifest: 'Directory.Build.props',
    install: 'dotnet restore',
    build: 'dotnet build',
    test: 'dotnet test',
    image: BASE_IMAGES.dotnetAspnet,
  },
  {
    id: 'php-laravel',
    label: 'PHP (Laravel)',
    description: 'Composer path repositories, one Laravel app per service, Pest',
    templates: ['php-laravel'],
    manifest: 'composer.json',
    install: 'composer install',
    build: 'composer run-script build',
    test: 'composer test',
    image: BASE_IMAGES.php,
  },
  {
    id: 'python',
    label: 'Python',
    description: 'uv workspace, one FastAPI app per service, pytest',
    templates: ['python'],
    manifest: 'pyproject.toml',
    install: 'uv sync',
    build: 'uv build',
    test: 'uv run pytest',
    image: BASE_IMAGES.python,
  },
];

export const STACK_OPTION_ID = 'stack';

export interface MonorepoStackOption {
  id: string;
  label: string;
  type: 'select';
  default: MonorepoStackId;
  options: MonorepoStackId[];
  optionLabels: Record<string, string>;
  description: string;
  showWhen?: (options: Record<string, any>) => boolean;
}

/** The wizard control that lets a monorepo pick its stack. */
export function monorepoStackOption(defaultStack: MonorepoStackId = 'node-ts'): MonorepoStackOption {
  return {
    id: STACK_OPTION_ID,
    label: 'Stack',
    type: 'select',
    default: defaultStack,
    options: MONOREPO_STACKS.map((stack) => stack.id),
    optionLabels: Object.fromEntries(MONOREPO_STACKS.map((stack) => [stack.id, stack.label])),
    description: 'The language every service in the monorepo is written in — each stack keeps its own native workspace tooling.',
  };
}

export function isMonorepoStackId(value: unknown): value is MonorepoStackId {
  return MONOREPO_STACKS.some((stack) => stack.id === value);
}

/**
 * Resolve the requested stack. Anything unknown — a payload from before the
 * option existed, a saved wizard state, a hand-edited request — resolves to
 * `node-ts`, which is what the template used to hard-code, so old requests
 * keep their exact tree.
 */
export function resolveMonorepoStack(options: Record<string, unknown> | undefined): MonorepoStackId {
  const requested = options?.[STACK_OPTION_ID];
  return isMonorepoStackId(requested) ? requested : 'node-ts';
}

/** The stack a stack template builds when it picks `microservices`, if any. */
export function monorepoStackForTemplate(templateId: string): MonorepoStackId | undefined {
  return MONOREPO_STACKS.find((stack) => stack.templates.includes(templateId))?.id;
}

export function monorepoStack(id: MonorepoStackId): MonorepoStackDescriptor {
  const found = MONOREPO_STACKS.find((stack) => stack.id === id);
  if (!found) {
    throw new Error(`Unknown monorepo stack: ${id}`);
  }
  return found;
}

export function monorepoStackLabel(id: MonorepoStackId): string {
  return monorepoStack(id).label;
}

/** Everything the stack planners need; mirrors `MonorepoPlan` in the host. */
export interface MonorepoTreePlan {
  projectName: string;
  description: string;
  version: string;
  /** Domain services, without the gateway. */
  services: readonly string[];
  /** Gateway service folder, or '' for none. */
  gateway: string;
  /** `none` | `rabbitmq` | `kafka` | `redis`. */
  broker: string;
  sharedPackage: boolean;
  /** Compose + one Dockerfile per service. */
  containerization: boolean;
}

/** `orders-api` -> `ordersApi` — the folder name as a code identifier. */
export function camel(name: string): string {
  return name
    .split(/[-_. ]+/)
    .filter(Boolean)
    .map((part, index) => (index === 0 ? part.toLowerCase() : part[0].toUpperCase() + part.slice(1).toLowerCase()))
    .join('');
}

/** `orders-api` -> `OrdersApi` — .NET type/namespace names. */
export function pascal(name: string): string {
  return name
    .split(/[-_. ]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1).toLowerCase())
    .join('');
}

/** `orders` -> `orders_svc` — a Python module-safe name. */
export function snake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[-_. ]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase())
    .join('_');
}

/** Stable solution GUID per project so a re-scaffold does not churn the .sln. */
function guidFor(name: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index++) {
    hash = (hash ^ name.charCodeAt(index)) * 0x01000193;
    hash >>>= 0;
  }
  const hex = (offset: number): string => (((hash >>> (offset * 3)) ^ (hash * (offset + 1))) >>> 0).toString(16).padStart(8, '0');
  return `${hex(0)}-${hex(1).slice(0, 4)}-${hex(2).slice(0, 4)}-${hex(3).slice(0, 4)}-${hex(4)}${hex(1).slice(4)}`.toUpperCase();
}

/** Gateway first, then the domain services — the order ports are handed out. */
function orderedServices(plan: MonorepoTreePlan): string[] {
  return plan.gateway ? [plan.gateway, ...plan.services] : [...plan.services];
}

function portFor(index: number, plan: MonorepoTreePlan): number {
  return plan.gateway && index === 0 ? 8080 : 8100 + index;
}

function brokerImage(broker: string): string | undefined {
  switch (broker) {
    case 'rabbitmq':
      return 'rabbitmq:3-management';
    case 'nats':
      return 'nats:2.10-alpine';
    case 'kafka':
      return 'bitnami/kafka:3.7';
    case 'redis':
      return 'redis:7-alpine';
    default:
      return undefined;
  }
}

function brokerUrl(broker: string): string {
  switch (broker) {
    case 'rabbitmq':
      return 'amqp://guest:guest@broker:5672';
    case 'nats':
      return 'nats://broker:4222';
    case 'kafka':
      return 'broker:9092';
    case 'redis':
      return 'redis://broker:6379';
    default:
      return '';
  }
}

function header(plan: MonorepoTreePlan, stack: MonorepoStackDescriptor): string {
  return [
    `# ${plan.projectName}`,
    '',
    plan.description || 'Microservices monorepo.',
    '',
    `- Stack: **${stack.label}**`,
    `- Workspace manifest: \`${stack.manifest}\``,
    `- Services: ${orderedServices(plan).map((name) => `\`${name}\``).join(', ')}`,
    plan.broker !== 'none' ? `- Broker: \`${plan.broker}\`` : '- Broker: none (services talk over HTTP)',
    '',
    '## Run it',
    '',
    '```bash',
    stack.install,
    plan.containerization ? 'docker compose up --build' : stack.build,
    '```',
    '',
    '## Test it',
    '',
    '```bash',
    stack.test,
    '```',
    '',
  ].join('\n');
}

/** The `docker-compose.yml` every stack shares — only the build contexts differ. */
function composeFile(
  plan: MonorepoTreePlan,
  serviceEntry: (name: string, index: number) => { context: string; environment: Record<string, string> }
): string {
  const lines: string[] = ['# Local microservices stack — `docker compose up --build`', 'services:'];
  orderedServices(plan).forEach((name, index) => {
    const entry = serviceEntry(name, index);
    lines.push(`  ${name}:`);
    lines.push(`    build:`);
    lines.push(`      context: ${entry.context}`);
    lines.push(`    ports:`);
    lines.push(`      - "${portFor(index, plan)}:${portFor(index, plan)}"`);
    const environment = { ...entry.environment };
    if (plan.broker !== 'none') {
      environment.BROKER_URL = brokerUrl(plan.broker);
    }
    const keys = Object.keys(environment);
    if (keys.length > 0) {
      lines.push('    environment:');
      for (const key of keys) {
        lines.push(`      ${key}: "${environment[key]}"`);
      }
    }
    if (plan.broker !== 'none') {
      lines.push('    depends_on:');
      lines.push('      - broker');
    }
    lines.push('    restart: unless-stopped');
  });

  const image = brokerImage(plan.broker);
  if (image) {
    lines.push('  broker:');
    lines.push(`    image: ${image}`);
    lines.push('    ports:');
    if (plan.broker === 'rabbitmq') {
      lines.push('      - "5672:5672"');
      lines.push('      - "15672:15672"');
    } else if (plan.broker === 'kafka') {
      lines.push('      - "9092:9092"');
    } else if (plan.broker === 'nats') {
      lines.push('      - "4222:4222"');
      lines.push('      - "8222:8222"');
    } else {
      lines.push('      - "6379:6379"');
    }
    lines.push('    restart: unless-stopped');
  }
  lines.push('');
  return lines.join('\n');
}

function envExample(plan: MonorepoTreePlan): string {
  const lines = [
    '# Copy to .env and adjust for your machine — docker compose reads it.',
    `COMPOSE_PROJECT_NAME=${camel(plan.projectName)}`,
  ];
  if (plan.broker !== 'none') {
    lines.push(`BROKER_URL=${brokerUrl(plan.broker)}`);
  }
  orderedServices(plan).forEach((name, index) => {
    lines.push(`${snake(name).toUpperCase()}_URL=http://localhost:${portFor(index, plan)}`);
  });
  lines.push('');
  return lines.join('\n');
}

// ──────────────────────────────────────────────
//  .NET
// ──────────────────────────────────────────────

function dotnetTree(plan: MonorepoTreePlan, stack: MonorepoStackDescriptor): Record<string, string> {
  const scope = pascal(plan.projectName);
  const projects: { name: string; csproj: string; guid: string }[] = [
    { name: 'Contracts', csproj: 'shared\\Contracts\\Contracts.csproj', guid: guidFor('Contracts') },
  ];
  for (const name of orderedServices(plan)) {
    const type = `${pascal(name)}.Service`;
    projects.push({ name: type, csproj: `services\\${pascal(name)}\\${type}.csproj`, guid: guidFor(type) });
  }

  const solution = [
    'Microsoft Visual Studio Solution File, Format Version 12.00',
    '# Visual Studio Version 17',
    'VisualStudioVersion = 17.9.34119.5',
    'MinimumVisualStudioVersion = 10.0.40219.1',
    ...projects.flatMap((project) => [
      `Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "${project.name}", "${project.csproj}", "{${project.guid}}"`,
      'EndProject',
    ]),
    'Global',
    '\tGlobalSection(SolutionConfigurationPlatforms) = preSolution',
    '\t\tDebug|Any CPU = Debug|Any CPU',
    '\t\tRelease|Any CPU = Release|Any CPU',
    '\tEndGlobalSection',
    '\tGlobalSection(ProjectConfigurationPlatforms) = postSolution',
    ...projects.flatMap((project) => [
      `\t\t{${project.guid}}.Debug|Any CPU.ActiveCfg = Debug|Any CPU`,
      `\t\t{${project.guid}}.Debug|Any CPU.Build.0 = Debug|Any CPU`,
      `\t\t{${project.guid}}.Release|Any CPU.ActiveCfg = Release|Any CPU`,
      `\t\t{${project.guid}}.Release|Any CPU.Build.0 = Release|Any CPU`,
    ]),
    '\tEndGlobalSection',
    'EndGlobal',
    '',
  ].join('\n');

  const files: Record<string, string> = {
    'global.json': JSON.stringify({ sdk: { version: '8.0.0', rollForward: 'latestMinor' } }, null, 2),
    'Directory.Build.props': [
      '<Project>',
      '  <PropertyGroup>',
      '    <TargetFramework>net8.0</TargetFramework>',
      '    <Nullable>enable</Nullable>',
      '    <ImplicitUsings>enable</ImplicitUsings>',
      '    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>',
      '  </PropertyGroup>',
      '</Project>',
      '',
    ].join('\n'),
    [`${scope}.sln`]: solution,
    'shared/Contracts/Contracts.csproj': [
      '<Project Sdk="Microsoft.NET.Sdk">',
      '  <PropertyGroup>',
      '    <RootNamespace>Contracts</RootNamespace>',
      '  </PropertyGroup>',
      '</Project>',
      '',
    ].join('\n'),
    'shared/Contracts/ServiceContracts.cs': [
      'namespace Contracts;',
      '',
      '/// <summary>Health payload every service returns on GET /health.</summary>',
      'public sealed record HealthResponse(string Status, string Service, string Version);',
      '',
      '/// <summary>Request envelope shared by the commands each service accepts.</summary>',
      'public sealed record CommandEnvelope<T>(string Id, string? CorrelationId, T Payload);',
      '',
    ].join('\n'),
    'docker-compose.yml': composeFile(plan, (name) => ({
      context: `./services/${pascal(name)}`,
      environment: { ASPNETCORE_URLS: 'http://+:8080', ASPNETCORE_ENVIRONMENT: 'Development' },
    })),
    '.env.example': envExample(plan),
    'README.md': header(plan, stack),
  };

  for (const name of orderedServices(plan)) {
    const type = `${pascal(name)}.Service`;
    const folder = `services/${pascal(name)}`;
    const isGateway = name === plan.gateway;
    files[`${folder}/${type}.csproj`] = [
      '<Project Sdk="Microsoft.NET.Sdk.Web">',
      '  <ItemGroup>',
      '    <ProjectReference Include="..\\..\\shared\\Contracts\\Contracts.csproj" />',
      '  </ItemGroup>',
      '</Project>',
      '',
    ].join('\n');
    files[`${folder}/Program.cs`] = [
      'using Contracts;',
      '',
      `var builder = WebApplication.CreateBuilder(args);`,
      'builder.Services.AddEndpointsApiExplorer();',
      'builder.Services.AddSwaggerGen();',
      '',
      'var app = builder.Build();',
      'app.UseSwagger();',
      'app.UseSwaggerUI();',
      '',
      // §4.2 CON-03/CON-04: liveness, readiness and a Prometheus endpoint.
      'long requestCount = 0;',
      'app.Use(async (context, next) =>',
      '{',
      '    Interlocked.Increment(ref requestCount);',
      '    await next();',
      '});',
      '',
      `var healthBody = new HealthResponse("ok", "${name}", "0.1.0");`,
      'long draining = 0;',
      '// SIGTERM ends up here first: readiness is withdrawn while liveness keeps',
      '// answering, so the endpoint stops routing instead of restarting the pod.',
      'app.Lifetime.ApplicationStopping.Register(() => Interlocked.Exchange(ref draining, 1));',
      `app.MapGet("${OBSERVABILITY_PATHS.live}", () => healthBody);`,
      `app.MapGet("${OBSERVABILITY_PATHS.legacy}", () => healthBody);`,
      `app.MapGet("${OBSERVABILITY_PATHS.ready}", () => Interlocked.Read(ref draining) == 0`,
      `    ? Results.Json(healthBody, statusCode: 200)`,
      `    : Results.Json(new { status = "draining", service = "${name}" }, statusCode: 503));`,
      `app.MapGet("${OBSERVABILITY_PATHS.metrics}", () => Results.Text(`,
      `    string.Join(Environment.NewLine, new[]`,
      `    {`,
      `        "# HELP http_requests_total Total HTTP requests handled",`,
      `        "# TYPE http_requests_total counter",`,
      `        $"http_requests_total{{service=\\"${name}\\"}} {Interlocked.Read(ref requestCount)}",`,
      `        string.Empty,`,
      `    }),`,
      `    "text/plain; version=0.0.4"));`,
      isGateway ? '' : `app.MapGet("${API_PREFIX}/${resourceNameFor(name)}", () => Results.Ok(new { service = "${name}", items = Array.Empty<object>() }));`,
      isGateway ? 'app.MapGet("/routes", () => Results.Ok(new { routes = Array.Empty<string>() }));' : '',
      '',
      'app.Run();',
      '',
    ]
      .filter((line) => line !== '')
      .join('\n');
    files[`${folder}/appsettings.json`] = JSON.stringify(
      {
        Logging: { LogLevel: { Default: 'Information', 'Microsoft.AspNetCore': 'Warning' } },
        AllowedHosts: '*',
      },
      null,
      2
    );
    files[`${folder}/Dockerfile`] = [
      '# Build stage — the whole solution is the context so project references resolve.',
      `FROM ${BASE_IMAGES.dotnetSdk} AS build`,
      'WORKDIR /src',
      'COPY . .',
      'RUN dotnet publish "services/' + pascal(name) + `/${type}.csproj" -c Release -o /app`,
      '',
      `FROM ${stack.image} AS runtime`,
      'WORKDIR /app',
      'COPY --from=build /app .',
      'ENV ASPNETCORE_URLS=http://+:8080',
      ...CURL_INSTALL_LINES,
      ...hardeningLines('dotnet-web', 8080),
      'EXPOSE 8080',
      `ENTRYPOINT ["dotnet", "${type}.dll"]`,
      '',
    ].join('\n');
  }

  return files;
}

// ──────────────────────────────────────────────
//  PHP / Laravel
// ──────────────────────────────────────────────

function phpLaravelTree(plan: MonorepoTreePlan, stack: MonorepoStackDescriptor): Record<string, string> {
  const scope = snake(plan.projectName) || 'monorepo';
  const files: Record<string, string> = {
    'composer.json': JSON.stringify(
      {
        name: `${scope}/monorepo`,
        type: 'project',
        description: plan.description,
        license: 'MIT',
        repositories: [
          { type: 'path', url: 'services/*' },
          ...(plan.sharedPackage ? [{ type: 'path', url: 'shared/*' }] : []),
        ],
        require: { php: '^8.3' },
        scripts: {
          test: 'phpunit --colors=always',
          build: 'composer install --no-dev --optimize-autoloader',
        },
        'require-dev': { 'phpunit/phpunit': '^11.0' },
      },
      null,
      2
    ),
    'phpunit.xml': [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<phpunit bootstrap="vendor/autoload.php" colors="true">',
      '  <testsuites>',
      '    <testsuite name="monorepo">',
      '      <directory suffix="Test.php">services</directory>',
      '    </testsuite>',
      '  </testsuites>',
      '</phpunit>',
      '',
    ].join('\n'),
    'docker-compose.yml': composeFile(plan, (name) => ({
      context: `./services/${name}`,
      environment: { APP_ENV: 'local', APP_DEBUG: 'true' },
    })),
    '.env.example': envExample(plan),
    'README.md': header(plan, stack),
  };

  if (plan.sharedPackage) {
    files['shared/Contracts/composer.json'] = JSON.stringify(
      {
        name: `${scope}/contracts`,
        type: 'library',
        autoload: { 'psr-4': { 'Contracts\\': 'src/' } },
      },
      null,
      2
    );
    files['shared/Contracts/src/HealthResponse.php'] = [
      '<?php',
      '',
      'declare(strict_types=1);',
      '',
      'namespace Contracts;',
      '',
      'final readonly class HealthResponse',
      '{',
      '    public function __construct(',
      '        public string $status,',
      '        public string $service,',
      '        public string $version,',
      '    ) {',
      '    }',
      '',
      '    /** @return array<string, string> */',
      '    public function toArray(): array',
      '    {',
      '        return [\'status\' => $this->status, \'service\' => $this->service, \'version\' => $this->version];',
      '    }',
      '}',
      '',
    ].join('\n');
  }

  for (const name of orderedServices(plan)) {
    const folder = `services/${name}`;
    files[`${folder}/composer.json`] = JSON.stringify(
      {
        name: `${scope}/${name}`,
        type: 'project',
        require: {
          php: '^8.3',
          'laravel/framework': '^11.0',
          ...(plan.sharedPackage ? { [`${scope}/contracts`]: '*' } : {}),
        },
        'require-dev': { 'phpunit/phpunit': '^11.0' },
        autoload: { 'psr-4': { [`Services\\${pascal(name)}\\`]: 'src/' } },
        scripts: { test: 'phpunit --colors=always' },
      },
      null,
      2
    );
    files[`${folder}/routes/api.php`] = [
      '<?php',
      '',
      'use Illuminate\\Support\\Facades\\Route;',
      '',
      // §4.2 CON-03/CON-04: liveness, readiness and /metrics are registered
      // in bootstrap/app.php, outside the /api/v1 prefix these routes carry.
      `Route::get('/${resourceNameFor(name)}', fn () => ['service' => '${name}', 'items' => []]);`,
      '',
    ].join('\n');
    files[`${folder}/bootstrap/app.php`] = [
      '<?php',
      '',
      'use Illuminate\\Foundation\\Application;',
'use Illuminate\\Support\\Facades\\Route;',
      '',
      'return Application::configure(basePath: dirname(__DIR__))',
      `    ->withRouting(`,
      `        api: __DIR__ . '/../routes/api.php',`,
      `        apiPrefix: '${API_PREFIX.slice(1)}',`,
      `        health: '${OBSERVABILITY_PATHS.live}',`,
      `        then: function () {`,
      `            Route::get('${OBSERVABILITY_PATHS.legacy}', fn () => ['status' => 'ok', 'service' => '${name}']);`,
      `            // Readiness must be able to withdraw this instance; liveness keeps`,
      `            // answering, so a draining deploy is not answered with a restart.`,
      `            Route::get('${OBSERVABILITY_PATHS.ready}', function () {`,
      `                $draining = filter_var(getenv('APP_DRAINING') ?: 'false', FILTER_VALIDATE_BOOLEAN);`,
      `                return response()->json(`,
      `                    ['status' => $draining ? 'draining' : 'ok', 'service' => '${name}'],`,
      `                    $draining ? 503 : 200`,
      `                );`,
      `            });`,
      `            Route::get('${OBSERVABILITY_PATHS.metrics}', function () {`,
      `                // PHP is stateless per request: a per-process counter would`,
      `                // always read 0. Wire a real collector (statsd, prometheus-php).`,
      `                return response(`,
      `                    '# HELP http_requests_total Total HTTP requests handled' . PHP_EOL`,
      `                    . '# TYPE http_requests_total counter' . PHP_EOL`,
      `                    . 'http_requests_total{service="${name}"} 0' . PHP_EOL`,
      `                    . PHP_EOL,`,
      `                    200,`,
      `                    ['content-type' => 'text/plain; version=0.0.4']`,
      `                );`,
      `            });`,
      `        },`,
      `    )`,
      '    ->create();',
      '',
    ].join('\n');
    files[`${folder}/public/index.php`] = [
      '<?php',
      '',
      'require __DIR__ . \'/../vendor/autoload.php\';',
      '',
      '$app = require __DIR__ . \'/../bootstrap/app.php\';',
      '$app->handleRequest(Illuminate\\Http\\Request::capture());',
      '',
    ].join('\n');
    files[`${folder}/Dockerfile`] = [
      `FROM ${stack.image} AS build`,
      'WORKDIR /app',
      'RUN apt-get update && apt-get install -y --no-install-recommends git unzip \\',
      '    && rm -rf /var/lib/apt/lists/*',
      `COPY --from=${BASE_IMAGES.composer} /usr/bin/composer /usr/bin/composer`,
      'COPY . .',
      'RUN composer install --no-interaction --prefer-dist',
      '',
      `FROM ${stack.image} AS runtime`,
      'WORKDIR /app',
      'COPY --from=build /app ./',
      ...hardeningLines('php-debian', portFor(orderedServices(plan).indexOf(name), plan)),
      `EXPOSE ${portFor(orderedServices(plan).indexOf(name), plan)}`,
      `CMD ["php", "-S", "0.0.0.0:${portFor(orderedServices(plan).indexOf(name), plan)}", "-t", "public"]`,
      '',
    ].join('\n');
  }

  return files;
}

// ──────────────────────────────────────────────
//  Python
// ──────────────────────────────────────────────

function pythonTree(plan: MonorepoTreePlan, stack: MonorepoStackDescriptor): Record<string, string> {
  const scope = snake(plan.projectName) || 'monorepo';
  const members = [...orderedServices(plan).map((name) => `services/${name}`)];
  if (plan.sharedPackage) {
    members.push('shared/contracts');
  }

  const files: Record<string, string> = {
    'pyproject.toml': [
      '[project]',
      `name = "${scope}"`,
      `version = "${plan.version || '0.1.0'}"`,
      plan.description ? `description = "${plan.description.replace(/"/g, "'")}"` : 'description = "Microservices monorepo"',
      'requires-python = ">=3.11"',
      '',
      '[tool.uv.workspace]',
      `members = [${members.map((member) => `"${member}"`).join(', ')}]`,
      '',
      '[tool.pytest.ini_options]',
      'testpaths = ["services"]',
      'pythonpath = ["."]',
      '',
    ].join('\n'),
    '.python-version': '3.12\n',
    'docker-compose.yml': composeFile(plan, (name) => ({
      context: `./services/${name}`,
      environment: { PYTHONUNBUFFERED: '1' },
    })),
    '.env.example': envExample(plan),
    'README.md': header(plan, stack),
  };

  if (plan.sharedPackage) {
    files['shared/contracts/pyproject.toml'] = [
      '[project]',
      'name = "contracts"',
      'version = "0.1.0"',
      'requires-python = ">=3.11"',
      'dependencies = ["pydantic>=2.7"]',
      '',
      '[build-system]',
      'requires = ["hatchling"]',
      'build-backend = "hatchling.build"',
      '',
    ].join('\n');
    files['shared/contracts/contracts/__init__.py'] = [
      '"""Payloads every service shares."""',
      '',
      'from pydantic import BaseModel',
      '',
      '',
      'class HealthResponse(BaseModel):',
      '    status: str = "ok"',
      '    service: str',
      '    version: str = "0.1.0"',
      '',
    ].join('\n');
  }

  for (const name of orderedServices(plan)) {
    const module = snake(name);
    const folder = `services/${name}`;
    const dependencies = ['"fastapi>=0.111"', '"uvicorn[standard]>=0.30"'];
    if (plan.sharedPackage) {
      dependencies.push('"contracts"');
    }
    files[`${folder}/pyproject.toml`] = [
      '[project]',
      `name = "${module}"`,
      'version = "0.1.0"',
      'requires-python = ">=3.11"',
      `dependencies = [${dependencies.join(', ')}]`,
      '',
      '[tool.uv.sources]',
      ...(plan.sharedPackage ? ['contracts = { workspace = true }'] : []),
      '',
      '[build-system]',
      'requires = ["hatchling"]',
      'build-backend = "hatchling.build"',
      '',
    ].join('\n');
    files[`${folder}/app/__init__.py`] = '';
    files[`${folder}/app/main.py`] = [
      'import os',

      'from fastapi import FastAPI, Response',
      'from fastapi.responses import JSONResponse',
      '',
      `app = FastAPI(title="${name}")`,
      '',
      '',
      // §4.2 CON-03/CON-04: liveness, readiness and a Prometheus endpoint, then the
      // domain route. The Dockerfile HEALTHCHECK probes the same liveness path.
      'REQUEST_COUNT = {"total": 0}',


      'def _draining() -> bool:',
      '    """True once this instance was told to stop; readiness then fails."""',
      '    flag = os.environ.get("APP_DRAINING", "").lower() in ("1", "true", "yes")',
      '    return flag or os.path.exists("/tmp/app-draining")',
      '',
      '',
      '@app.middleware("http")',
      'async def count_requests(request, call_next):',
      '    REQUEST_COUNT["total"] += 1',
      '    return await call_next(request)',
      '',
      '',
      `@app.get("${OBSERVABILITY_PATHS.live}")`,
      `@app.get("${OBSERVABILITY_PATHS.legacy}")`,
      'def live() -> dict[str, str]:',
      `    return {"status": "ok", "service": "${name}", "version": "0.1.0"}`,
      '',
      '',
      `@app.get("${OBSERVABILITY_PATHS.ready}")`,
      'def ready() -> Response:',
      '    # Uvicorn drains in-flight requests on SIGTERM; readiness is withdrawn',
      '    # first (APP_DRAINING=true or /tmp/app-draining) so traffic stops here.',
      '    if _draining():',
      '        return JSONResponse(',
      `            {"status": "draining", "service": "${name}"}, status_code=503`,
      '        )',
      `    return JSONResponse({"status": "ok", "service": "${name}", "version": "0.1.0"})`,
      '',
      '',
      `@app.get("${OBSERVABILITY_PATHS.metrics}")`,
      'def metrics() -> Response:',
      '    body = "\\n".join([',
      '        "# HELP http_requests_total Total HTTP requests handled",',
      '        "# TYPE http_requests_total counter",',
      `        'http_requests_total{service="${name}"} ' + str(REQUEST_COUNT["total"]),`,
      '        "",',
      '    ])',
      '    return Response(content=body, media_type="text/plain; version=0.0.4")',
      '',
      '',
      `@app.get("${API_PREFIX}/${resourceNameFor(name)}")`,
      `def ${module}() -> dict[str, str]:`,
      `    return {"service": "${name}"}`,
      '',
    ].join('\n');
    files[`${folder}/Dockerfile`] = [
      `FROM ${stack.image} AS build`,
      'WORKDIR /app',
      'ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1',
      'RUN pip install --no-cache-dir uv',
      'COPY . .',
      'RUN uv venv /opt/venv && uv pip install --python /opt/venv/bin/python --no-cache .',
      '',
      `FROM ${stack.image} AS runtime`,
      'WORKDIR /app',
      'ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PATH=/opt/venv/bin:$PATH',
      'COPY --from=build /opt/venv /opt/venv',
      'COPY --from=build /app .',
      ...hardeningLines('python-debian', portFor(orderedServices(plan).indexOf(name), plan)),
      `EXPOSE ${portFor(orderedServices(plan).indexOf(name), plan)}`,
      `CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "${portFor(orderedServices(plan).indexOf(name), plan)}"]`,
      '',
    ].join('\n');
  }

  return files;
}

/**
 * Contracts for a tree plan: one entry per domain service, with the port the
 * planners actually assign it. The gateway is excluded — it forwards the
 * `/api/v1` prefix verbatim, so its public surface is the union of the others.
 */
function contractPlan(plan: MonorepoTreePlan): ContractPlan {
  const services = orderedServices(plan)
    .map((name, index) => ({ name, port: portFor(index, plan) }))
    .filter((entry) => entry.name !== plan.gateway)
    .map((entry) => ({
      name: entry.name,
      port: entry.port,
      resource: resourceNameFor(entry.name),
      events: defaultEventsFor(entry.name),
    }));

  return { projectName: plan.projectName, description: plan.description, services };
}

/**
 * Every file the monorepo layout needs for `stack`, as `path -> content`.
 *
 * `node-ts` deliberately has no planner here: its writer already exists and is
 * pinned by the phase-2 golden fixtures, so routing it through this map would
 * churn a tree that is already correct.
 *
 * The contract artifacts (`contracts/openapi/*.yaml`, `contracts/events/*.json`)
 * are merged in for every stack, so a Python or Laravel monorepo is contract
 * first in exactly the same sense a TypeScript one is.
 */
export function planMonorepoTree(stack: MonorepoStackId, plan: MonorepoTreePlan): Record<string, string> {
  return { ...stackTree(stack, plan), ...planContractFiles(contractPlan(plan)) };
}

function stackTree(stack: MonorepoStackId, plan: MonorepoTreePlan): Record<string, string> {
  switch (stack) {
    case 'dotnet':
      return dotnetTree(plan, monorepoStack('dotnet'));
    case 'php-laravel':
      return phpLaravelTree(plan, monorepoStack('php-laravel'));
    case 'python':
      return pythonTree(plan, monorepoStack('python'));
    default:
      throw new Error(`planMonorepoTree: ${stack} keeps its dedicated writer`);
  }
}
