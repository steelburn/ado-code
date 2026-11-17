import * as assert from 'assert';
import {
  API_PREFIX,
  CONTRACTS_DIR,
  CONTRACTS_README_PATH,
  ENVELOPE_REQUIRED,
  OPENAPI_VERSION,
  ContractPlan,
  ServiceContract,
  buildEnvelopeSchema,
  buildEventSchema,
  buildOpenApiDocument,
  defaultEventsFor,
  envelopeSchemaPath,
  eventKeyFor,
  eventSchemaPath,
  openApiPath,
  planContractFiles,
  resourceNameFor,
  singularize,
  toYaml,
} from '../../../shared/contractArtifacts';
import { HEALTHCHECK_PATH } from '../../../shared/containerHardening';
import { MONOREPO_STACKS, MonorepoTreePlan, planMonorepoTree } from '../../../shared/monorepoStacks';

/**
 * CON-02 — the contract-first artifacts.
 *
 * The point of these tests is not "a file was produced" (a golden fixture would
 * cover that) but that the emitted document is *internally consistent*: every
 * `$ref` resolves, every event a document advertises has a schema file next to
 * it, and no stack can drift out of the `/api/v1` prefix. Those are the
 * properties a consumer or a CI gate actually relies on.
 */

const PLAN: ContractPlan = {
  projectName: 'acme-platform',
  description: 'Acme platform.',
  services: [
    { name: 'orders-api', port: 8100, resource: 'orders', events: ['order.created', 'order.updated'] },
    { name: 'billing', port: 8101, resource: 'billing', events: [] },
  ],
};

const ORDERS: ServiceContract = PLAN.services[0];

/** Every component schema referenced from a document body. */
function refsIn(yaml: string): string[] {
  const found: string[] = [];
  const re = /\$ref: '#\/components\/schemas\/([A-Za-z0-9_]+)'/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(yaml)) !== null) {
    found.push(match[1]);
  }
  return found;
}

suite('contractArtifacts — YAML writer', () => {
  test('quotes values that YAML would otherwise reinterpret', () => {
    const yaml = toYaml({
      ref: '#/components/schemas/ApiError',
      numeric: '200',
      boolish: 'true',
      colon: 'a: b',
      empty: '',
      plain: 'orders',
      number: 42,
      flag: false,
    });

    assert.ok(yaml.includes("ref: '#/components/schemas/ApiError'"), yaml);
    assert.ok(yaml.includes("numeric: '200'"), yaml);
    assert.ok(yaml.includes("boolish: 'true'"), yaml);
    assert.ok(yaml.includes("colon: 'a: b'"), yaml);
    assert.ok(yaml.includes("empty: ''"), yaml);
    assert.ok(yaml.includes('plain: orders'), yaml);
    assert.ok(yaml.includes('number: 42'), yaml);
    assert.ok(yaml.includes('flag: false'), yaml);
  });

  test('renders nested maps and sequences of maps', () => {
    const yaml = toYaml({
      outer: { inner: { leaf: 'x' } },
      list: [{ a: '1', b: '2' }, 'scalar'],
      emptyList: [],
      emptyMap: {},
    });

    assert.ok(yaml.includes('outer:\n  inner:\n    leaf: x'), yaml);
    assert.ok(yaml.includes('list:\n  - a: \'1\'\n    b: \'2\'\n  - scalar'), yaml);
    assert.ok(yaml.includes('emptyList: []'), yaml);
    assert.ok(yaml.includes('emptyMap: {}'), yaml);
  });

  test('is deterministic — same input, byte-identical output', () => {
    assert.strictEqual(toYaml(buildOpenApiDocument(PLAN, ORDERS)), toYaml(buildOpenApiDocument(PLAN, ORDERS)));
  });
});

suite('contractArtifacts — OpenAPI document', () => {
  const doc = buildOpenApiDocument(PLAN, ORDERS);
  const yaml = toYaml(doc);
  const paths = doc.paths as Record<string, unknown>;
  const schemas = (doc.components as { schemas: Record<string, unknown> }).schemas;

  test('declares OpenAPI 3.1', () => {
    assert.ok(yaml.startsWith(`openapi: ${OPENAPI_VERSION}`), yaml.slice(0, 80));
    assert.strictEqual(OPENAPI_VERSION, '3.1.0');
  });

  test('every route lives under the /api/v1 prefix, except health', () => {
    assert.deepStrictEqual(Object.keys(paths), [
      `${API_PREFIX}/orders`,
      `${API_PREFIX}/orders/{id}`,
      HEALTHCHECK_PATH,
    ]);
    assert.strictEqual(API_PREFIX, '/api/v1');
  });

  test('every $ref resolves to a component the document defines', () => {
    const refs = refsIn(yaml);
    assert.ok(refs.length > 0, 'the document should use schema refs');
    for (const name of refs) {
      assert.ok(schemas[name], `unresolved $ref '#/components/schemas/${name}'`);
    }
  });

  test('advertised events point at files the plan actually emits', () => {
    const files = planContractFiles(PLAN);
    const publishes = doc['x-publishes'] as Array<{ event: string; schema: string }>;
    assert.strictEqual(publishes.length, 2);
    for (const entry of publishes) {
      assert.ok(files[entry.schema], `${entry.event} advertises missing ${entry.schema}`);
      assert.strictEqual(entry.schema, eventSchemaPath(entry.event));
    }
  });

  test('a service with no events carries no x-publishes key', () => {
    const billing = buildOpenApiDocument(PLAN, PLAN.services[1]);
    assert.strictEqual(billing['x-publishes'], undefined);
  });

  test('names the local server after the port the planner assigns', () => {
    const servers = doc.servers as Array<{ url: string }>;
    assert.strictEqual(servers[0].url, 'http://localhost:8100');
  });
});

suite('contractArtifacts — event schemas', () => {
  test('every event schema requires exactly the envelope fields', () => {
    const envelope = buildEnvelopeSchema();
    assert.deepStrictEqual(envelope.required, [...ENVELOPE_REQUIRED]);

    for (const event of ['order.created', 'order.updated', 'notification.sent']) {
      const schema = buildEventSchema(event);
      assert.deepStrictEqual(schema.required, [...ENVELOPE_REQUIRED], `${event} diverges from the envelope`);
      assert.strictEqual(schema.additionalProperties, false);
    }
  });

  test('each event pins its own eventType and the contract version', () => {
    const schema = buildEventSchema('order.created');
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    assert.deepStrictEqual(properties.eventType, { const: 'order.created' });
    assert.deepStrictEqual(properties.version, { type: 'integer', const: 1 });
    assert.strictEqual(properties.eventId.format, 'uuid');
    assert.strictEqual(properties.timestamp.format, 'date-time');
  });

  test('the envelope leaves eventType open and documents correlationId', () => {
    const properties = buildEnvelopeSchema().properties as Record<string, Record<string, unknown>>;
    assert.strictEqual(properties.eventType.type, 'string');
    assert.ok(properties.correlationId, 'correlationId is part of the envelope');
  });

  test('emits parseable JSON with a stable $id', () => {
    const body = planContractFiles(PLAN)[eventSchemaPath('order.created')];
    const parsed = JSON.parse(body);
    assert.strictEqual(parsed.$id, 'order.created.v1.json');
    assert.strictEqual(parsed.$schema, 'https://json-schema.org/draft/2020-12/schema');
  });
});

suite('contractArtifacts — emitted file set', () => {
  const files = planContractFiles(PLAN);

  test('emits one document per service plus the envelope and a README', () => {
    assert.deepStrictEqual(Object.keys(files).sort(), [
      CONTRACTS_README_PATH,
      envelopeSchemaPath(),
      eventSchemaPath('order.created'),
      eventSchemaPath('order.updated'),
      openApiPath('billing'),
      openApiPath('orders-api'),
    ].sort());
  });

  test('every path is inside contracts/ and carries the contract version', () => {
    for (const relativePath of Object.keys(files)) {
      assert.ok(relativePath.startsWith(`${CONTRACTS_DIR}/`), relativePath);
    }
    assert.strictEqual(openApiPath('orders-api'), 'contracts/openapi/orders-api.v1.yaml');
    assert.strictEqual(eventSchemaPath('order.created'), 'contracts/events/order.created.v1.json');
    assert.strictEqual(envelopeSchemaPath(), 'contracts/events/envelope.v1.json');
  });

  test('the README lists every service and its events', () => {
    const readme = files[CONTRACTS_README_PATH];
    assert.ok(readme.includes('`orders-api`'), readme);
    assert.ok(readme.includes('`order.created`'), readme);
    assert.ok(readme.includes('`billing`'), readme);
  });

  test('is deterministic', () => {
    assert.deepStrictEqual(planContractFiles(PLAN), planContractFiles(PLAN));
  });
});

suite('contractArtifacts — naming', () => {
  test('strips a service suffix to find the collection', () => {
    assert.strictEqual(resourceNameFor('orders-api'), 'orders');
    assert.strictEqual(resourceNameFor('notification-service'), 'notification');
    assert.strictEqual(resourceNameFor('billing-svc'), 'billing');
    assert.strictEqual(resourceNameFor('billing'), 'billing');
  });

  test('singularises only the obvious plurals', () => {
    assert.strictEqual(singularize('orders'), 'order');
    assert.strictEqual(singularize('status'), 'status');
    assert.strictEqual(singularize('addresses'), 'address');
    assert.strictEqual(singularize('categories'), 'category');
    assert.strictEqual(singularize('users'), 'user');
  });

  test('derives created + updated events from the service name', () => {
    assert.deepStrictEqual(defaultEventsFor('orders-api'), ['order.created', 'order.updated']);
    assert.deepStrictEqual(defaultEventsFor('notifications'), [
      'notification.created',
      'notification.updated',
    ]);
  });

  test('builds a camelCase key from an event name', () => {
    assert.strictEqual(eventKeyFor('order.created'), 'orderCreated');
    assert.strictEqual(eventKeyFor('notification.requested'), 'notificationRequested');
  });
});

suite('contractArtifacts — every monorepo stack is contract-first', () => {
  const treePlan: MonorepoTreePlan = {
    projectName: 'acme-platform',
    description: 'Acme platform.',
    version: '0.1.0',
    services: ['orders-api', 'billing'],
    gateway: 'gateway',
    broker: 'nats',
    sharedPackage: true,
    containerization: true,
  };

  for (const stack of MONOREPO_STACKS) {
    if (stack.id === 'node-ts') {
      // Dedicated writer, pinned by the golden fixtures instead.
      continue;
    }

    test(`${stack.id}: emits a contract per domain service and the envelope`, () => {
      const tree = planMonorepoTree(stack.id, treePlan);
      for (const service of treePlan.services) {
        assert.ok(
          tree[openApiPath(service)],
          `${stack.id} is missing ${openApiPath(service)}`
        );
        const yaml = tree[openApiPath(service)];
        assert.ok(yaml.includes(`openapi: ${OPENAPI_VERSION}`), `${stack.id}/${service}`);
        assert.ok(yaml.includes(`${API_PREFIX}/${resourceNameFor(service)}`), `${stack.id}/${service}`);
      }
      assert.ok(tree[envelopeSchemaPath()], `${stack.id} is missing the envelope schema`);
      assert.ok(tree[CONTRACTS_README_PATH], `${stack.id} is missing contracts/README.md`);
    });

    test(`${stack.id}: serves its resources under /api/v1`, () => {
      const tree = planMonorepoTree(stack.id, treePlan);
      const routeFiles = Object.entries(tree).filter(
        ([relativePath]) =>
          relativePath.startsWith('services/') &&
          /(\.py|\.php|Program\.cs|index\.ts)$/.test(relativePath)
      );
      assert.ok(routeFiles.length > 0, `${stack.id} emits no route files?`);

      let prefixed = 0;
      for (const [relativePath, body] of routeFiles) {
        // Laravel expresses the same prefix through `apiPrefix: 'api/v1'` in
        // bootstrap/app.php, so both spellings count as declared.
        if (!body.includes(API_PREFIX) && !body.includes(API_PREFIX.slice(1))) {
          continue;
        }
        prefixed += 1;
        // The bare `/orders-api` form the boilerplates used to serve is gone.
        assert.ok(
          !body.includes(`"/orders-api"`) && !body.includes(`'/orders-api'`),
          `${relativePath} still routes on the unprefixed service name`
        );
      }
      assert.ok(prefixed > 0, `${stack.id} never mentions ${API_PREFIX}`);
    });
  }
});
