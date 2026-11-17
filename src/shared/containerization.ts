/**
 * Containerization for the single-project templates.
 *
 * Why a central planner instead of edits inside every writer: the wizard's
 * project types had very uneven container support — only `node-ts` and
 * `dotnet-webapi` wrote a `Dockerfile`, the rest shipped nothing even though
 * they are perfectly containerizable. Making "containerize this" a property of
 * the *stack* (resolved once, planned once, written by the host) is what lets
 * every project type offer it without fourteen copies of the same Dockerfile.
 *
 * Pure data + pure functions: no `fs`, no `vscode`, so the host owns the I/O
 * and the tests can assert the generated content directly.
 */

import { BASE_IMAGES, CURL_INSTALL_LINES, hardeningLines } from './containerHardening';

export type ContainerTarget = 'node' | 'python' | 'php' | 'dotnet' | 'react' | 'next' | 'none';

interface TargetSpec {
  /** Port the container listens on; also the published port in Compose. */
  port: number;
  dockerfile: string;
  /** Extra ignore rules beyond the shared set. */
  ignore?: readonly string[];
}

/** Template id -> container target. Anything absent is not containerizable. */
const TARGETS: Record<string, ContainerTarget> = {
  'node-ts': 'node',
  'node-js': 'node',
  python: 'python',
  'php-laravel': 'php',
  php: 'php',
  'dotnet-webapi': 'dotnet',
  'dotnet-console': 'dotnet',
  'react-ts': 'react',
  nextjs: 'next',
};

/**
 * Templates that stay uncontainerized on purpose: mobile apps (built on the
 * device), documentation sets (Markdown sources) and the bare `empty` folder.
 */
const NOT_APPLICABLE = new Set([
  'react-native',
  'flutter',
  'dotnet-maui',
  'doc-ba',
  'doc-writer',
  'doc-tester',
  'empty',
  'test-automation',
]);

export function containerTargetForTemplate(templateId: string): ContainerTarget {
  if (NOT_APPLICABLE.has(templateId)) {
    return 'none';
  }
  return TARGETS[templateId] ?? 'none';
}

/** True when the wizard should offer the "Containerize with Docker" toggle. */
export function supportsContainerization(templateId: string): boolean {
  return containerTargetForTemplate(templateId) !== 'none';
}

export interface ContainerPlanOptions {
  /** Project name — used for the Compose service and image names. */
  projectName: string;
  /** Overrides the stack's default port. */
  port?: number;
  version?: string;
}

const SHARED_IGNORE = [
  '.git',
  '.gitignore',
  'Dockerfile',
  '.dockerignore',
  'docker-compose.yml',
  'node_modules',
  'dist',
  'out',
  'bin',
  'obj',
  'vendor',
  '__pycache__',
  '.venv',
  '.env',
  '*.log',
];

function nodeFiles(port: number): string {
  return [
    '# syntax=docker/dockerfile:1',
    `FROM ${BASE_IMAGES.node} AS build`,
    'WORKDIR /app',
    'COPY package*.json ./',
    'RUN npm ci',
    'COPY . .',
    'RUN npm run build --if-present',
    '',
    `FROM ${BASE_IMAGES.node} AS runtime`,
    'ENV NODE_ENV=production',
    'WORKDIR /app',
    'COPY --from=build /app/package*.json ./',
    'RUN npm ci --omit=dev',
    'COPY --from=build /app/dist ./dist',
    ...hardeningLines('node-alpine', port),
    `EXPOSE ${port}`,
    'CMD ["node", "dist/index.js"]',
    '',
  ].join('\n');
}

function pythonFiles(port: number): string {
  return [
    `FROM ${BASE_IMAGES.python} AS build`,
    'WORKDIR /app',
    'RUN pip install --no-cache-dir uv',
    'COPY pyproject.toml ./',
    'COPY . .',
    'RUN uv venv /opt/venv && uv pip install --python /opt/venv/bin/python --no-cache .',
    '',
    `FROM ${BASE_IMAGES.python} AS runtime`,
    'ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PATH=/opt/venv/bin:$PATH',
    'WORKDIR /app',
    'COPY --from=build /opt/venv /opt/venv',
    'COPY --from=build /app/app ./app',
    'COPY --from=build /app/pyproject.toml ./pyproject.toml',
    ...hardeningLines('python-debian', port),
    `EXPOSE ${port}`,
    `CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "${port}"]`,
    '',
  ].join('\n');
}

function phpFiles(port: number): string {
  return [
    `FROM ${BASE_IMAGES.php} AS build`,
    'WORKDIR /app',
    'RUN apt-get update && apt-get install -y --no-install-recommends git unzip \\',
    '    && rm -rf /var/lib/apt/lists/*',
    `COPY --from=${BASE_IMAGES.composer} /usr/bin/composer /usr/bin/composer`,
    'COPY . .',
    'RUN composer install --no-interaction --prefer-dist --no-dev || true',
    '',
    `FROM ${BASE_IMAGES.php} AS runtime`,
    'WORKDIR /app',
    'COPY --from=build /app ./',
    ...hardeningLines('php-debian', port),
    `EXPOSE ${port}`,
    `CMD ["php", "-S", "0.0.0.0:${port}", "-t", "public"]`,
    '',
  ].join('\n');
}

function dotnetFiles(port: number, isWeb: boolean): string {
  if (!isWeb) {
    return [
      `FROM ${BASE_IMAGES.dotnetSdk} AS build`,
      'WORKDIR /src',
      'COPY . .',
      'RUN dotnet publish -c Release -o /app',
      '',
      `FROM ${BASE_IMAGES.dotnetRuntime} AS runtime`,
      'WORKDIR /app',
      'COPY --from=build /app .',
      ...hardeningLines('dotnet-console', port),
      'ENTRYPOINT ["dotnet", "app.dll"]',
      '',
    ].join('\n');
  }
  return [
    `FROM ${BASE_IMAGES.dotnetSdk} AS build`,
    'WORKDIR /src',
    'COPY . .',
    'RUN dotnet publish -c Release -o /app',
    '',
    `FROM ${BASE_IMAGES.dotnetAspnet} AS runtime`,
    'WORKDIR /app',
    'COPY --from=build /app .',
    `ENV ASPNETCORE_URLS=http://+:${port}`,
    ...CURL_INSTALL_LINES,
    ...hardeningLines('dotnet-web', port),
    `EXPOSE ${port}`,
    'ENTRYPOINT ["dotnet", "app.dll"]',
    '',
  ].join('\n');
}

function reactFiles(port: number): string {
  return [
    '# syntax=docker/dockerfile:1',
    `FROM ${BASE_IMAGES.node} AS build`,
    'WORKDIR /app',
    'COPY package*.json ./',
    'RUN npm ci',
    'COPY . .',
    'RUN npm run build',
    '',
    `FROM ${BASE_IMAGES.nginxUnprivileged} AS runtime`,
    'COPY --from=build /app/dist /usr/share/nginx/html',
    ...hardeningLines('nginx-static', port),
    `EXPOSE ${port}`,
    '',
  ].join('\n');
}

function nextFiles(port: number): string {
  return [
    '# syntax=docker/dockerfile:1',
    `FROM ${BASE_IMAGES.node} AS build`,
    'WORKDIR /app',
    'COPY package*.json ./',
    'RUN npm ci',
    'COPY . .',
    'RUN npm run build',
    '',
    `FROM ${BASE_IMAGES.node} AS runtime`,
    'ENV NODE_ENV=production',
    'WORKDIR /app',
    'COPY --from=build /app ./.next ./.next',
    'COPY --from=build /app/node_modules ./node_modules',
    'COPY --from=build /app/package.json ./package.json',
    'COPY --from=build /app/public ./public',
    ...hardeningLines('node-alpine', port),
    `EXPOSE ${port}`,
    'CMD ["npm", "run", "start"]',
    '',
  ].join('\n');
}

function specFor(target: ContainerTarget, templateId: string, port: number | undefined): TargetSpec | undefined {
  const resolvedPort = port ?? (target === 'react' ? 8080 : target === 'dotnet' ? 8080 : target === 'python' || target === 'php' ? 8000 : 3000);
  switch (target) {
    case 'node':
      return { port: resolvedPort, dockerfile: nodeFiles(resolvedPort) };
    case 'python':
      return { port: resolvedPort, dockerfile: pythonFiles(resolvedPort) };
    case 'php':
      return { port: resolvedPort, dockerfile: phpFiles(resolvedPort) };
    case 'dotnet':
      return { port: resolvedPort, dockerfile: dotnetFiles(resolvedPort, templateId !== 'dotnet-console') };
    case 'react':
      return { port: resolvedPort, dockerfile: reactFiles(resolvedPort) };
    case 'next':
      return { port: resolvedPort, dockerfile: nextFiles(resolvedPort) };
    default:
      return undefined;
  }
}

/**
 * `path -> content` for a single-project container setup: the Dockerfile, a
 * `.dockerignore` and a one-service `docker-compose.yml`. Empty for a template
 * that is not containerizable.
 */
export function planContainerFiles(
  templateId: string,
  options: ContainerPlanOptions
): Record<string, string> {
  const target = containerTargetForTemplate(templateId);
  const spec = specFor(target, templateId, options.port);
  if (!spec) {
    return {};
  }

  const service = options.projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'app';

  const compose = [
    '# Local container — `docker compose up --build`',
    'services:',
    `  ${service}:`,
    '    build:',
    '      context: .',
    `    ports:`,
    `      - "${spec.port}:${spec.port}"`,
    '    env_file:',
    '      - .env',
    '    restart: unless-stopped',
    '',
  ].join('\n');

  return {
    Dockerfile: spec.dockerfile,
    '.dockerignore': [...SHARED_IGNORE, ...(spec.ignore ?? [])].join('\n') + '\n',
    'docker-compose.yml': compose,
  };
}
