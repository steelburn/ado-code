/**
 * `/new-service` — the pure half of "add one service to an existing
 * microservices repo".
 *
 * Why this module exists: `ProjectCreationService` can only build a *whole*
 * project, so growing a monorepo by one service had no path at all — the agent
 * fell back to hand-writing files from memory and the wizard required starting
 * over. This module owns everything that does not touch the file system
 * (marker parsing, name rules, the compose/env/README/CI patches, the worker
 * entrypoints), which keeps `addService()` in the service down to detection +
 * writing and makes every rule testable without a scratch dir.
 *
 * Deliberate non-goal: it never *rewrites* a file it patches. Every patch
 * either appends into a recognised block or returns `null` so the caller can
 * warn and move on — an existing compose/README/CI file the module cannot
 * parse is never reformatted.
 */

import { MonorepoStackId, isMonorepoStackId } from './monorepoStacks';

/** Committed architecture marker — the thing that makes a repo "microservices". */
export const PROJECT_MARKER_FILE = '.ado-project.json';

export type ServiceKind = 'api' | 'worker';

/**
 * The marker's payload. `architecture: 'microservices'` is what `/new-service`
 * keys on; everything else is context so the service can be generated without
 * re-asking the wizard's questions.
 */
export interface ProjectMarker {
  stack: MonorepoStackId;
  architecture: 'microservices';
  /** npm / pnpm / yarn / turborepo / nx — Node stacks only. */
  workspaceTool?: string;
  /** `none` | `rabbitmq` | `kafka` | `redis`. */
  broker?: string;
  /** `postgres` | `mysql` | `sqlite` | `mongo` | `none`. */
  db?: string;
  /** Default kind offered when one is not specified. */
  serviceKind?: ServiceKind;
}

/**
 * Names the generated tree reserves for cross-cutting folders. `gateway` is
 * deliberately absent: it is a real service in these repos.
 */
export const RESERVED_SERVICE_NAMES: readonly string[] = ['shared', 'contracts', 'infra'];

const SERVICE_NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** `orders-api` -> `ORDERS_API` — the env/identifier stem for a service. */
export function serviceStem(name: string): string {
  return name.replace(/-/g, '_').toUpperCase();
}

/** `orders-api` -> `ORDERS_API_URL`, matching the wizard's `envVar()`. */
export function serviceEnvKey(name: string): string {
  return `${serviceStem(name)}_URL`;
}

export function normalizeServiceKind(value: unknown): ServiceKind {
  return value === 'worker' ? 'worker' : 'api';
}

/**
 * Validate a service name. Returns `null` when it is usable, else a message the
 * user can act on — the same string is shown by the palette command, the slash
 * command and the `add_service` tool.
 */
export function serviceNameError(name: string, existing: readonly string[]): string | null {
  const trimmed = (name ?? '').trim();
  if (!trimmed) {
    return 'A service name is required, e.g. `/new-service orders-api`.';
  }
  if (trimmed !== name) {
    return `"${name}" has leading or trailing whitespace.`;
  }
  if (!SERVICE_NAME_RE.test(name)) {
    return `"${name}" is not kebab-case — use lowercase letters, digits and single dashes (e.g. "orders-api").`;
  }
  if (RESERVED_SERVICE_NAMES.includes(name)) {
    return `"${name}" is reserved for a cross-cutting folder — pick a domain name (e.g. "orders-api").`;
  }
  if (existing.includes(name)) {
    return `"${name}" already exists in this repo — pick another name or remove it first.`;
  }
  return null;
}

/** Parse `.ado-project.json`; `null` when absent or unreadable/foreign. */
export function parseProjectMarker(text: string | null | undefined): ProjectMarker | null {
  if (!text) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (obj.architecture !== 'microservices' || !isMonorepoStackId(obj.stack)) {
    return null;
  }
  const marker: ProjectMarker = { stack: obj.stack, architecture: 'microservices' };
  if (typeof obj.workspaceTool === 'string' && obj.workspaceTool) {
    marker.workspaceTool = obj.workspaceTool;
  }
  if (typeof obj.broker === 'string' && obj.broker) {
    marker.broker = obj.broker;
  }
  if (typeof obj.db === 'string' && obj.db) {
    marker.db = obj.db;
  }
  if (obj.serviceKind === 'api' || obj.serviceKind === 'worker') {
    marker.serviceKind = obj.serviceKind;
  }
  return marker;
}

/** Stable marker serialisation — key order is fixed so the file never churns. */
export function serializeProjectMarker(marker: ProjectMarker): string {
  const ordered: Record<string, string> = {
    stack: marker.stack,
    architecture: marker.architecture,
  };
  if (marker.workspaceTool) {
    ordered.workspaceTool = marker.workspaceTool;
  }
  if (marker.broker) {
    ordered.broker = marker.broker;
  }
  if (marker.db) {
    ordered.db = marker.db;
  }
  if (marker.serviceKind) {
    ordered.serviceKind = marker.serviceKind;
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// docker-compose patching (text-level: no YAML parser, zero runtime deps)
// ---------------------------------------------------------------------------

/** Only the two-space indentation the wizard emits is understood. */
const COMPOSE_SERVICE_KEY = /^ {2}([A-Za-z0-9_.-]+):\s*$/;
const COMPOSE_TOP_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*:/;
const COMPOSE_PORT = /^\s*-\s*"?(\d+):(\d+)"?\s*$/;

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** Index range of the `services:` block, or `null` when there is none. */
function servicesBlockRange(lines: readonly string[]): { start: number; end: number } | null {
  const start = lines.findIndex(line => /^services:\s*$/.test(line));
  if (start < 0) {
    return null;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (COMPOSE_TOP_KEY.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** Service keys declared under `services:` in that order. */
export function composeServiceNames(compose: string): string[] {
  const lines = splitLines(compose);
  const range = servicesBlockRange(lines);
  if (!range) {
    return [];
  }
  const names: string[] = [];
  for (let i = range.start + 1; i < range.end; i++) {
    const match = COMPOSE_SERVICE_KEY.exec(lines[i]);
    if (match) {
      names.push(match[1]);
    }
  }
  return names;
}

/** Published host ports per service (`"4100:4100"` -> 4100). */
export function composeServicePorts(compose: string): Record<string, number> {
  const lines = splitLines(compose);
  const range = servicesBlockRange(lines);
  const ports: Record<string, number> = {};
  if (!range) {
    return ports;
  }
  let current: string | null = null;
  for (let i = range.start + 1; i < range.end; i++) {
    const key = COMPOSE_SERVICE_KEY.exec(lines[i]);
    if (key) {
      current = key[1];
      continue;
    }
    if (!current) {
      continue;
    }
    const port = COMPOSE_PORT.exec(lines[i]);
    if (port && ports[current] === undefined) {
      ports[current] = Number(port[1]);
    }
  }
  return ports;
}

/**
 * The exact lines of one service entry, `   orders-api:` included, or `null`
 * when the service is absent. Used to reuse the wizard's own compose generator:
 * a single-service compose is generated and its block lifted out.
 */
export function extractComposeServiceBlock(compose: string, name: string): string | null {
  const lines = splitLines(compose);
  const range = servicesBlockRange(lines);
  if (!range) {
    return null;
  }
  let start = -1;
  for (let i = range.start + 1; i < range.end; i++) {
    const match = COMPOSE_SERVICE_KEY.exec(lines[i]);
    if (match && match[1] === name) {
      start = i;
      break;
    }
  }
  if (start < 0) {
    return null;
  }
  let end = range.end;
  for (let i = start + 1; i < range.end; i++) {
    if (COMPOSE_SERVICE_KEY.test(lines[i]) || COMPOSE_TOP_KEY.test(lines[i])) {
      end = i;
      break;
    }
  }
  while (end > start + 1 && lines[end - 1].trim() === '') {
    end--;
  }
  return lines.slice(start, end).join('\n');
}

/**
 * Append a service block at the end of the `services:` map. Returns `null` when
 * the document has no recognisable `services:` block or already declares the
 * name — the caller reports that instead of guessing at a rewrite.
 */
export function appendComposeService(compose: string, name: string, block: string): string | null {
  const lines = splitLines(compose);
  const range = servicesBlockRange(lines);
  if (!range || composeServiceNames(compose).includes(name)) {
    return null;
  }
  let insertAt = range.end;
  while (insertAt > range.start + 1 && lines[insertAt - 1].trim() === '') {
    insertAt--;
  }
  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);
  const body = [...before];
  if (body.length > 0 && body[body.length - 1].trim() !== '' && !COMPOSE_SERVICE_KEY.test(body[body.length - 1])) {
    // keep the existing entries separated from the new one
    body.push('');
  }
  const merged = [...body, ...block.split('\n'), ...(after.length > 0 ? [''] : []), ...after];
  return `${merged.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// .env.example / README / docs / CI patches
// ---------------------------------------------------------------------------

/** `ORDERS_API_URL=http://localhost:4100` — the key the other services need. */
export function serviceEnvLines(name: string, port: number, kind: ServiceKind): string[] {
  if (kind === 'worker') {
    return [];
  }
  return [`${serviceEnvKey(name)}=http://localhost:${port}`];
}

/** Append keys that are not already present; returns the text unchanged otherwise. */
export function appendEnvKeys(env: string, lines: readonly string[]): string {
  const present = new Set(
    splitLines(env)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .map(line => line.split('=')[0])
  );
  const missing = lines.filter(line => line && !present.has(line.split('=')[0]));
  if (missing.length === 0) {
    return env;
  }
  const trimmed = env.replace(/\s*$/, '');
  return `${trimmed}${trimmed ? '\n' : ''}${missing.join('\n')}\n`;
}

/**
 * Add a row to the first Markdown table whose header mentions "service".
 * Returns `null` when the README has no such table — never invents structure.
 */
export function appendReadmeServiceRow(readme: string, cells: readonly string[]): string | null {
  const lines = splitLines(readme);
  const header = lines.findIndex(line => /^\|\s*service/i.test(line.trim()));
  if (header < 0) {
    return null;
  }
  const row = `| ${cells.join(' | ')} |`;
  // walk to the last contiguous table line, then insert before trailing blanks
  let last = header;
  for (let i = header + 1; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('|')) {
      break;
    }
    last = i;
  }
  if (lines.slice(header, last + 1).some(line => line.trim() === row.trim())) {
    return null;
  }
  const next = [...lines.slice(0, last + 1), row, ...lines.slice(last + 1)];
  return next.join('\n');
}

/**
 * Append the service to the architecture doc's service section — a table row
 * when the document keeps a catalogue table (the wizard's own layout), a bullet
 * when it keeps a list. `null` when there is no such section, and the document
 * unchanged when the service is already listed.
 */
export function appendArchitectureService(
  doc: string,
  name: string,
  kind: ServiceKind,
  stack: string,
  port?: number
): string | null {
  const lines = splitLines(doc);
  const start = lines.findIndex(line => /^#{1,6}\s+(services|service\s+catalog)\s*$/i.test(line.trim()));
  if (start < 0) {
    return null;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const section = lines.slice(start + 1, end);
  const listed = section.some(line => line.includes(`\`${name}\``) || new RegExp(`(^|[^\\w-])${name}([^\\w-]|$)`).test(line));
  if (listed) {
    return lines.join('\n');
  }

  const bullets = section
    .map((line, index) => (/^\s*[-*]\s+\S/.test(line) ? start + 1 + index : -1))
    .filter(index => index >= 0);
  if (bullets.length > 0) {
    const at = bullets[bullets.length - 1] + 1;
    return [...lines.slice(0, at), `- \`${name}\` — ${kind} service (${stack}).`, ...lines.slice(at)].join('\n');
  }

  // The wizard's own layout is a catalogue table: add a row with the same
  // number of columns rather than a bullet the table would not render.
  const rows = section.map((line, index) => (/^\s*\|.*\|\s*$/.test(line) ? start + 1 + index : -1)).filter(index => index >= 0);
  if (rows.length >= 2) {
    const header = splitRow(lines[rows[0]]);
    const values = [`\`${name}\``, `\`services/${name}\``, port === undefined ? '—' : String(port), `${kind} — ${stack}`];
    const row = `| ${header.map((_, index) => values[index] ?? '—').join(' | ')} |`;
    const at = rows[rows.length - 1] + 1;
    return [...lines.slice(0, at), row, ...lines.slice(at)].join('\n');
  }
  return null;
}

/** Cells of a markdown table row, trimmed, without the outer pipes. */
function splitRow(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  return (inner.endsWith('|') ? inner.slice(0, -1) : inner).split('|').map(cell => cell.trim());
}
/**
 * Append a service to a GitHub Actions `strategy.matrix.service` list. `null`
 * when no workflow declares one — a matrix the module cannot see is not
 * something it should edit.
 */
export function appendCiMatrixService(ci: string, name: string): string | null {
  const lines = splitLines(ci);

  // Block form: `service:` followed by `- name` items.
  const blockStart = lines.findIndex(line => /^\s*service:\s*$/.test(line));
  if (blockStart >= 0) {
    const indent = /^(\s*)/.exec(lines[blockStart])?.[1] ?? '';
    const itemIndent = `${indent}  `;
    let last = blockStart;
    for (let i = blockStart + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') {
        continue;
      }
      if (/^\s*-\s/.test(line)) {
        last = i;
        if (line.trim().replace(/^-\s*/, '') === name) {
          return null;
        }
        continue;
      }
      break;
    }
    return [...lines.slice(0, last + 1), `${itemIndent}- ${name}`, ...lines.slice(last + 1)].join('\n');
  }

  // Inline flow sequence — what the monorepo wizard itself writes:
  // `service: [orders-api, billing-api]`. Without this branch the module could
  // not patch the CI file the scaffolder had just generated.
  const inline = lines.findIndex(line => /^\s*service:\s*\[[^\]]*\]\s*$/.test(line));
  if (inline < 0) {
    return null;
  }
  const line = lines[inline];
  const open = line.indexOf('[');
  const close = line.lastIndexOf(']');
  const entries = line
    .slice(open + 1, close)
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
  if (entries.some(entry => entry.replace(/^['"]|['"]$/g, '') === name)) {
    return null;
  }
  const out = [...lines];
  out[inline] = `${line.slice(0, open + 1)}${[...entries, name].join(', ')}${line.slice(close)}`;
  return out.join('\n');
}
/** Strip the published port and set a worker command on a generated compose block. */
export function asWorkerComposeBlock(block: string, stack: MonorepoStackId, service: string): string {
  const command = workerCommand(stack, service);
  const kept: string[] = [];
  const lines = splitLines(block);
  let skippingPorts = false;
  for (const line of lines) {
    if (/^\s{4}ports:\s*$/.test(line)) {
      skippingPorts = true;
      continue;
    }
    if (skippingPorts && /^\s{6}-\s/.test(line)) {
      continue;
    }
    if (skippingPorts) {
      skippingPorts = false;
    }
    kept.push(line);
  }
  if (command) {
    const head = kept[0];
    kept.splice(1, 0, `    command: ${command}`);
    void head;
  }
  return kept.join('\n');
}

/** The queue-worker command for a stack, or `''` when the host runs itself. */
export function workerCommand(stack: MonorepoStackId, service: string): string {
  switch (stack) {
    case 'node-ts':
      return 'node dist/worker.js';
    case 'python':
      return `python -m app.worker`;
    case 'php-laravel':
      return 'php artisan queue:work';
    case 'dotnet':
      return '';
    default:
      void service;
      return '';
  }
}
/**
 * Whether the stack can host a `worker` at all. `/new-service --kind worker`
 * must refuse rather than write a second service that publishes no port and
 * runs the api's own entrypoint — a container doing nothing.
 */
export function serviceSupportsWorker(stack: MonorepoStackId): boolean {
  // The start command is what makes a container a worker: it can reuse the
  // api's entrypoint (Laravel runs `artisan queue:work` in the same image),
  // but with no command at all the container would run the api instead.
  return workerCommand(stack, 'sample').length > 0;
}

/**
 * Extra entrypoint a worker needs on top of the stack's api body. Laravel ships
 * its queue worker as an artisan command and .NET's host is the same assembly,
 * so both return nothing.
 */
export function workerEntrypointFiles(stack: MonorepoStackId, service: string): Record<string, string> {
  const pascal = (value: string) =>
    value
      .split(/[-_. ]+/)
      .filter(Boolean)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');

  switch (stack) {
    case 'node-ts':
      return {
        [`services/${service}/src/worker.ts`]: [
          '/**',
          ` * ${service} worker — the same image as the api, started with`,
          ' * `node dist/worker.js` and no published port.',
          ' *',
          ' * Wire the broker/queue client here; keep the HTTP server out of this',
          ' * entrypoint so a worker does not fight the api for the port.',
          ' */',
          'async function main(): Promise<void> {',
          '  // TODO: connect to the broker and process messages.',
          '}',
          '',
          'void main();',
          '',
        ].join('\n'),
      };
    case 'python':
      return {
        [`services/${service}/app/worker.py`]: [
          `"""${service} worker — same image as the api, no HTTP port."""`,
          '',
          '',
          'def main() -> None:',
          '    # TODO: connect to the broker and process messages.',
          '    pass',
          '',
          '',
          'if __name__ == "__main__":',
          '    main()',
          '',
        ].join('\n'),
      };
    case 'dotnet':
      return {
        [`services/${service}/Worker.cs`]: [
          `namespace ${pascal(service)};`,
          '',
          '/// <summary>',
          `/// ${service} worker — hosted service consuming the broker. The api host`,
          '/// publishes no port for a worker process.',
          '/// </summary>',
          `public sealed class Worker : BackgroundService`,
          '{',
          '    private readonly ILogger<Worker> _logger;',
          '',
          '    public Worker(ILogger<Worker> logger) => _logger = logger;',
          '',
          '    protected override async Task ExecuteAsync(CancellationToken stoppingToken)',
          '    {',
          '        // TODO: connect to the broker and process messages.',
          '        await Task.Delay(Timeout.Infinite, stoppingToken);',
          '    }',
          '}',
          '',
        ].join('\n'),
      };
    case 'php-laravel':
    default:
      return {};
  }
}
