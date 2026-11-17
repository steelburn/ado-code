import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { TOOL_DISPLAY_NAMES, TOOL_GROUP_MAP } from '../../../llm/tools/types';
import { extractComposeServiceBlock } from '../../../shared/serviceScaffold';
import { ProjectCreationService } from '../../../webview/ProjectCreationService';
import { cleanTempDir } from '../utils/cleanTempDir';
import { makeScratchDir } from '../utils/scratchDir';

/**
 * `addService` — the single implementation behind `/new-service`, the palette
 * command and the `add_service` tool.
 *
 * The repo is grown, not regenerated: the new service folder must not exist,
 * and every other target is patched in place. These tests pin the append-only
 * behaviour, the refusals and the consent gate.
 */

const COMPOSE = [
  'services:',
  '  orders-api:',
  '    build: ./services/orders-api',
  '    ports:',
  '      - "3001:3000"',
  '    environment:',
  '      - PORT=3000',
  '',
  'volumes:',
  '  pgdata:',
  '',
].join('\n');

const MARKER = JSON.stringify({
  stack: 'node-ts',
  architecture: 'microservices',
  workspaceTool: 'npm',
  broker: 'rabbitmq',
  db: 'postgres',
});

const README = [
  '# Shop',
  '',
  '| Service | Kind | Port | Description |',
  '| --- | --- | --- | --- |',
  '| `orders-api` | api | 3001 | Orders |',
  '',
].join('\n');

const ARCHITECTURE = ['# Architecture', '', '## Services', '', '- `orders-api` — api (node-ts)', ''].join('\n');

const CI = ['name: ci', 'jobs:', '  build:', '    strategy:', '      matrix:', '        service: [orders-api]', ''].join('\n');

/** A minimal but real microservices repo: marker, one service, the side files. */
function writeRepo(root: string): void {
  const write = (rel: string, content: string): void => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  };
  write('.ado-project.json', MARKER);
  write('docker-compose.yml', COMPOSE);
  write('.env.example', 'PORT=3000\nORDERS_API_URL=http://localhost:3001\n');
  write('README.md', README);
  write('docs/architecture.md', ARCHITECTURE);
  write('.github/workflows/ci.yml', CI);
  write('services/orders-api/package.json', '{"name":"orders-api"}');
}

function readRepo(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
}

function listFiles(root: string, dir: string): string[] {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) {
    return [];
  }
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(child);
      } else {
        out.push(path.relative(root, child).replace(/\\/g, '/'));
      }
    }
  };
  walk(full);
  return out;
}

suite('addService — growing an existing microservices repo', () => {
  let root: string;
  let service: ProjectCreationService;

  setup(() => {
    root = makeScratchDir('ado-add-service-');
    writeRepo(root);
    service = new ProjectCreationService();
  });

  teardown(() => {
    cleanTempDir(root);
  });

  test('appends the service folder and patches compose, env, README, docs and CI in place', () => {
    const before = listFiles(root, 'services');
    const result = service.addService({ workspaceRoot: root, name: 'payments-api' });

    assert.strictEqual(result.ok, true, `expected success, got: ${result.error}`);
    assert.strictEqual(result.service, 'payments-api');
    assert.strictEqual(result.kind, 'api');
    assert.strictEqual(typeof result.port, 'number', 'an api publishes a port');

    // The new folder exists and carries files; the old one is untouched.
    const servicesAfter = listFiles(root, 'services');
    const added = servicesAfter.filter(file => file.startsWith('services/payments-api/'));
    assert.ok(added.length > 0, 'the service folder must be written');
    for (const file of before) {
      assert.ok(servicesAfter.includes(file), `${file} must survive untouched`);
    }
    assert.ok(
      (result.written ?? []).some(file => file.startsWith('services/payments-api/')),
      'written must list the new service files'
    );

    // Append-only patches: the existing entries are all still there.
    const compose = readRepo(root, 'docker-compose.yml');
    assert.ok(compose.includes('payments-api'), 'compose gained the service');
    assert.ok(compose.includes('orders-api'), 'compose kept the first service');
    assert.ok(compose.includes(`"${result.port}:`), 'the published port landed in compose');
    assert.ok(compose.includes('volumes:'), 'the rest of the compose file survives');

    const env = readRepo(root, '.env.example');
    assert.ok(env.includes('PAYMENTS_API_URL'), 'the env key is documented');
    assert.ok(env.includes('ORDERS_API_URL'), 'the existing env key survives');

    assert.ok(readRepo(root, 'README.md').includes('orders-api'));
    assert.ok(readRepo(root, 'docs/architecture.md').includes('orders-api'));
    assert.ok(readRepo(root, '.github/workflows/ci.yml').includes('orders-api'));

    assert.ok(result.patched?.includes('docker-compose.yml'), 'compose is reported as patched');
    assert.ok(result.patched?.includes('.env.example'), 'env is reported as patched');
  });

  test('refuses a name that already exists and writes nothing', () => {
    const composeBefore = readRepo(root, 'docker-compose.yml');
    const result = service.addService({ workspaceRoot: root, name: 'orders-api' });

    assert.strictEqual(result.ok, false);
    assert.ok(result.error && /exists|already/i.test(result.error), `got: ${result.error}`);
    assert.strictEqual(readRepo(root, 'docker-compose.yml'), composeBefore, 'a refusal must not touch the repo');
  });

  test('refuses an invalid or reserved name before detecting the repo', () => {
    for (const name of ['Orders_API', 'shared', 'contracts', 'infra']) {
      const result = service.addService({ workspaceRoot: root, name });
      assert.strictEqual(result.ok, false, `${name} must be refused`);
      assert.ok(result.error && result.error.length > 20, `${name} needs an actionable message`);
    }
    assert.ok(!fs.existsSync(path.join(root, 'services', 'shared')), 'nothing may be created');
  });

  test('refuses a folder that is not a microservices repo, pointing at /new-project', () => {
    const emptyRoot = makeScratchDir('ado-add-service-empty-');
    try {
      const result = service.addService({ workspaceRoot: emptyRoot, name: 'payments-api' });
      assert.strictEqual(result.ok, false);
      assert.ok(/microservices repo/i.test(result.error ?? ''), `got: ${result.error}`);
      assert.ok(/new-project/i.test(result.error ?? ''), 'the message must say where to start');
      assert.deepStrictEqual(listFiles(emptyRoot, '.'), [], 'a refusal must write nothing');
    } finally {
      cleanTempDir(emptyRoot);
    }
  });

  test('a dry run reports the plan and writes nothing', () => {
    const filesBefore = listFiles(root, '.');
    const composeBefore = readRepo(root, 'docker-compose.yml');

    const result = service.addService({ workspaceRoot: root, name: 'payments-api', dryRun: true });

    assert.strictEqual(result.ok, true, `expected a preview, got: ${result.error}`);
    assert.strictEqual(result.dryRun, true);
    assert.ok(result.preview?.compose.includes('payments-api'), 'the preview shows the compose patch');
    assert.ok((result.preview?.files.length ?? 0) > 0, 'the preview lists the files it would write');
    assert.deepStrictEqual(listFiles(root, '.'), filesBefore, 'a dry run must not create files');
    assert.strictEqual(readRepo(root, 'docker-compose.yml'), composeBefore, 'a dry run must not patch compose');
  });

  test('a worker publishes no port and gets the worker entrypoint', () => {
    const result = service.addService({ workspaceRoot: root, name: 'payments-worker', kind: 'worker' });
    assert.strictEqual(result.ok, true, `expected success, got: ${result.error}`);
    assert.strictEqual(result.kind, 'worker');

    const compose = readRepo(root, 'docker-compose.yml');
    const block = extractComposeServiceBlock(compose, 'payments-worker');
    assert.ok(block, 'the worker must appear in compose');
    assert.ok(!/ports:/.test(block!), 'a worker must not publish a port');
  });

  test('is idempotent: a second identical call is refused, not duplicated', () => {
    const first = service.addService({ workspaceRoot: root, name: 'payments-api' });
    assert.strictEqual(first.ok, true, `expected success, got: ${first.error}`);

    const composeAfterFirst = readRepo(root, 'docker-compose.yml');
    const second = service.addService({ workspaceRoot: root, name: 'payments-api' });

    assert.strictEqual(second.ok, false);
    assert.strictEqual(readRepo(root, 'docker-compose.yml'), composeAfterFirst, 'the second call must change nothing');
    const composeAfterSecond = readRepo(root, 'docker-compose.yml');
    assert.strictEqual(
      composeAfterSecond.split('payments-api').length,
      composeAfterFirst.split('payments-api').length,
      'the service must not be appended twice'
    );
  });
});

suite('add_service — registration', () => {
  test('is registered as a write-group tool with a display name', () => {
    assert.ok(TOOL_GROUP_MAP.write.includes('add_service'), 'it belongs to the write group');
    assert.ok(TOOL_DISPLAY_NAMES.add_service, 'the approval card needs a label');
  });
});
