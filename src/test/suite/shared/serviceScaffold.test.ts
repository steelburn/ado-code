import * as assert from 'assert';
import {
  PROJECT_MARKER_FILE,
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
  serviceEnvKey,
  serviceNameError,
  serviceStem,
  serviceSupportsWorker,
  workerCommand,
  workerEntrypointFiles,
} from '../../../shared/serviceScaffold';
import { describeAddServiceResult } from '../../../shared/addServiceReport';

/**
 * `/new-service` writes into an existing repo, so every helper here is
 * append-only and must return `null` (never a rewrite) when it cannot parse
 * what it finds. These tests pin that contract.
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
].join('\n');

const NEW_BLOCK = [
  '  payments-api:',
  '    build: ./services/payments-api',
  '    ports:',
  '      - "3002:3000"',
].join('\n');

suite('serviceScaffold — name rules', () => {
  test('accepts kebab-case service names', () => {
    for (const name of ['orders-api', 'payments', 'billing-worker', 'api2']) {
      assert.strictEqual(serviceNameError(name, []), null, `${name} should be valid`);
    }
  });

  test('rejects names that are not kebab-case, with a per-failure message', () => {
    const bad = ['', '  ', 'Orders-API', 'orders_api', '-orders', 'orders-', 'orders--api', '9orders', 'orders api'];
    for (const name of bad) {
      const error = serviceNameError(name, []);
      assert.ok(error && error.length > 20, `"${name}" should be rejected with an explanation`);
    }
  });

  test('reserves the shared folders but not gateway', () => {
    for (const name of ['shared', 'contracts', 'infra']) {
      assert.ok(serviceNameError(name, []), `${name} is a workspace folder, not a service`);
    }
    assert.strictEqual(serviceNameError('gateway', []), null, 'a gateway is a legitimate service');
  });

  test('reports an existing service by name', () => {
    const error = serviceNameError('orders-api', ['orders-api']);
    assert.ok(error);
    assert.ok(error!.includes('orders-api'), 'the message must name the collision');
  });

  test('derives the env key and the stem from the name', () => {
    assert.strictEqual(serviceStem('orders-api'), 'ORDERS_API');
    assert.strictEqual(serviceEnvKey('orders-api'), 'ORDERS_API_URL');
  });

  test('defaults the kind to api', () => {
    assert.strictEqual(normalizeServiceKind('worker'), 'worker');
    assert.strictEqual(normalizeServiceKind('api'), 'api');
    assert.strictEqual(normalizeServiceKind(undefined), 'api');
    assert.strictEqual(normalizeServiceKind('nonsense'), 'api');
  });
});

suite('serviceScaffold — project marker', () => {
  const good = { stack: 'node-ts', architecture: 'microservices' } as const;

  test('round-trips a marker and keeps the key order stable', () => {
    const text = serializeProjectMarker({
      ...good,
      workspaceTool: 'npm',
      broker: 'rabbitmq',
      db: 'postgres',
    } as never);
    const parsed = parseProjectMarker(text);
    assert.ok(parsed, 'the serialized marker must parse back');
    assert.strictEqual(parsed!.stack, 'node-ts');
    assert.strictEqual(parsed!.architecture, 'microservices');
    assert.strictEqual(serializeProjectMarker(parsed!), text, 're-serializing must be byte-identical');
    assert.ok(
      text.indexOf('"stack"') < text.indexOf('"architecture"'),
      'fixed key order keeps diffs small'
    );
  });

  test('rejects anything that is not a microservices marker', () => {
    assert.strictEqual(parseProjectMarker(null), null);
    assert.strictEqual(parseProjectMarker(''), null);
    assert.strictEqual(parseProjectMarker('{'), null);
    assert.strictEqual(parseProjectMarker('{"stack":"node-ts","architecture":"monolith"}'), null);
    assert.strictEqual(parseProjectMarker('{"stack":"rust","architecture":"microservices"}'), null);
    assert.strictEqual(parseProjectMarker('[]'), null);
  });

  test('names the marker file it reads', () => {
    assert.strictEqual(PROJECT_MARKER_FILE, '.ado-project.json');
  });
});

suite('serviceScaffold — compose patching', () => {
  test('reads the declared services and their published ports', () => {
    assert.deepStrictEqual(composeServiceNames(COMPOSE), ['orders-api']);
    assert.deepStrictEqual(composeServicePorts(COMPOSE), { 'orders-api': 3001 });
  });

  test('lifts one service block out of a compose file', () => {
    const block = extractComposeServiceBlock(COMPOSE, 'orders-api');
    assert.ok(block);
    assert.ok(block!.includes('3001:3000'), 'the block keeps its ports');
    assert.ok(!block!.includes('volumes:'), 'the block stops at the next top-level key');
    assert.strictEqual(extractComposeServiceBlock(COMPOSE, 'payments-api'), null);
  });

  test('appends a new service inside services:, above the other top-level keys', () => {
    const next = appendComposeService(COMPOSE, 'payments-api', NEW_BLOCK);
    assert.ok(next);
    assert.deepStrictEqual(composeServiceNames(next!), ['orders-api', 'payments-api']);
    assert.ok(next!.indexOf('payments-api') < next!.indexOf('volumes:'), 'must stay under services:');
    assert.deepStrictEqual(composeServicePorts(next!), { 'orders-api': 3001, 'payments-api': 3002 });
  });

  test('refuses to touch a compose file it cannot parse or a duplicate service', () => {
    assert.strictEqual(appendComposeService(COMPOSE, 'orders-api', NEW_BLOCK), null, 'duplicate');
    assert.strictEqual(appendComposeService('resources:\n  x: 1\n', 'payments-api', NEW_BLOCK), null, 'no services:');
  });

  test('a worker publishes no ports and gets the worker command', () => {
    const block = asWorkerComposeBlock(NEW_BLOCK, 'node-ts', 'payments-worker');
    assert.ok(!/ports:/.test(block), 'a worker must not publish a port');
    assert.ok(block.includes(workerCommand('node-ts', 'payments-worker')), 'the block runs the worker entrypoint');
  });

  test('every stack that hosts a worker knows how to start it', () => {
    for (const stack of ['node-ts', 'php-laravel', 'python'] as const) {
      assert.strictEqual(serviceSupportsWorker(stack), true, `${stack} supports a worker`);
      assert.ok(workerCommand(stack, 'payments-worker').length > 0, `${stack} must know how to start it`);
    }
    // A worker is identified by its start command, so a stack may reuse the
    // framework's CLI instead of generating a second entrypoint: Laravel runs
    // `artisan queue:work` from the api's own code.
    assert.ok(Object.keys(workerEntrypointFiles('node-ts', 'payments-worker')).length > 0);
    assert.ok(Object.keys(workerEntrypointFiles('python', 'payments-worker')).length > 0);
    assert.deepStrictEqual(Object.keys(workerEntrypointFiles('php-laravel', 'payments-worker')), []);
    // A stack without a worker host must be refused, not silently given a
    // second api that publishes no port.
    assert.strictEqual(serviceSupportsWorker('dotnet'), false);
  });
});

suite('serviceScaffold — append-only document patches', () => {
  const env = 'PORT=3000\nORDERS_API_URL=http://localhost:3001\n';

  test('adds the missing env keys only', () => {
    const next = appendEnvKeys(env, ['PAYMENTS_API_URL=http://localhost:3002', 'ORDERS_API_URL=http://localhost:3001']);
    assert.strictEqual(next.split('PAYMENTS_API_URL').length, 2, 'the new key is added exactly once');
    assert.strictEqual(next.split('ORDERS_API_URL').length, 2, 'the existing key is not duplicated');
  });

  test('is idempotent for a fully-covered env file', () => {
    const once = appendEnvKeys(env, ['PAYMENTS_API_URL=http://localhost:3002']);
    assert.strictEqual(appendEnvKeys(once, ['PAYMENTS_API_URL=http://localhost:3002']), once);
  });

  test('adds a README table row, or reports there is no table', () => {
    const readme = '| Service | Kind | Port | Description |\n| --- | --- | --- | --- |\n| `orders-api` | api | 3001 | Orders |\n';
    const next = appendReadmeServiceRow(readme, ['`payments-api`', 'api', '3002', 'Payments']);
    assert.ok(next && next.includes('`payments-api`'));
    assert.ok(next!.includes('`orders-api`'), 'the existing row survives');
    assert.strictEqual(appendReadmeServiceRow('# Title\n\nNo table here.\n', ['`payments-api`']), null);
  });

  test('extends a catalogue table the way the wizard writes it', () => {
    const doc = [
      '# Shop — microservices architecture',
      '',
      '## Service catalog',
      '',
      '| Service | Folder | Port | Responsibility |',
      '| --- | --- | --- | --- |',
      '| `orders-api` | `services/orders-api` | 3001 | Orders |',
      '',
    ].join('\n');
    const next = appendArchitectureService(doc, 'payments-api', 'api', 'node-ts', 3002);
    assert.ok(next, 'the catalogue table must be extended');
    assert.ok(next!.includes('`payments-api`'), 'the new row is added');
    assert.ok(next!.includes('3002'), 'the port lands in the row');
    assert.ok(next!.includes('`orders-api`'), 'the existing row survives');
    assert.strictEqual(
      next!.split('\n').filter(line => line.startsWith('|')).length,
      doc.split('\n').filter(line => line.startsWith('|')).length + 1,
      'exactly one row is added'
    );
    assert.strictEqual(appendArchitectureService(next!, 'payments-api', 'api', 'node-ts', 3002), next, 'already listed → unchanged');
  });

  test('adds the service to the architecture doc and the CI matrix', () => {
    const doc = '# Architecture\n\n## Services\n\n- `orders-api` — api\n';
    const nextDoc = appendArchitectureService(doc, 'payments-api', 'api', 'node-ts');
    assert.ok(nextDoc && nextDoc.includes('payments-api'));
    assert.ok(nextDoc!.includes('`orders-api`'), 'the existing bullet survives');
    assert.strictEqual(appendArchitectureService('# Architecture\n', 'payments-api', 'api', 'node-ts'), null);

    const ci = 'strategy:\n  matrix:\n    service: [orders-api, billing-api]\n';
    const nextCi = appendCiMatrixService(ci, 'payments-api');
    assert.strictEqual(nextCi, 'strategy:\n  matrix:\n    service: [orders-api, billing-api, payments-api]\n', 'an inline matrix is patched in place');
    assert.strictEqual(appendCiMatrixService(nextCi!, 'payments-api'), null, 'duplicate');
    const blockCi = 'strategy:\n  matrix:\n    service:\n      - orders-api\n';
    const nextBlock = appendCiMatrixService(blockCi, 'payments-api');
    assert.strictEqual(nextBlock, 'strategy:\n  matrix:\n    service:\n      - orders-api\n      - payments-api\n', 'a block matrix is appended to');
    assert.strictEqual(appendCiMatrixService('name: ci\n', 'payments-api'), null);
  });
});

suite('describeAddServiceResult', () => {
  test('reports what was written, patched and published', () => {
    const text = describeAddServiceResult({
      ok: true,
      service: 'payments-api',
      stack: 'node-ts',
      kind: 'api',
      port: 3002,
      written: ['services/payments-api/package.json'],
      patched: ['docker-compose.yml'],
      envKeys: ['PAYMENTS_API_URL'],
    });
    assert.ok(text.includes('payments-api'));
    assert.ok(text.includes('3002'));
    assert.ok(text.includes('docker-compose.yml'));
    assert.ok(text.includes('services/payments-api/package.json'));
  });

  test('states a refusal instead of a summary', () => {
    const text = describeAddServiceResult({ ok: false, error: 'services/payments-api already exists' });
    assert.ok(text.includes('services/payments-api already exists'));
  });

  test('marks a dry run as a preview and lists its warnings', () => {
    const text = describeAddServiceResult({
      ok: true,
      service: 'payments-api',
      dryRun: true,
      preview: { compose: 'services:\n', files: ['services/payments-api/package.json'] },
      warnings: ['README.md has no service table to extend'],
    });
    assert.ok(/preview|dry run/i.test(text), 'a dry run must not read as a completed write');
    assert.ok(text.includes('README.md has no service table to extend'));
  });
});
