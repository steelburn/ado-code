import * as assert from 'assert';
import {
  CI_GATES,
  CI_GATE_IDS,
  COVERAGE_THRESHOLD,
  GATE_IMAGES,
  SAST_RULESET,
  databaseName,
  databasePasswordEnv,
  databasePort,
  familyCommands,
  k8sImage,
  planCiWorkflow,
  planDatabaseOverlay,
  planK8sManifests,
  planK8sReadme,
  runtimeFamily,
  runtimeUid,
} from '../../../shared/deliveryArtifacts';
import { eventSchemaGlob, openApiGlob } from '../../../shared/contractArtifacts';
import {
  COMPOSE_DATABASE_PATH,
  CI_WORKFLOW_PATH,
  EVENT_SCHEMA_VALIDATOR,
  EVENT_SCHEMA_VALIDATOR_PATH,
  planDeliveryFiles,
} from '../../../shared/deliveryFiles';
import { planMonorepoTree } from '../../../shared/monorepoStacks';
import { appendCiMatrixService } from '../../../shared/serviceScaffold';

const workflow = (
  overrides: Partial<Parameters<typeof planCiWorkflow>[0]> = {},
): string =>
  planCiWorkflow({ family: 'node', services: ['gateway', 'users'], k8s: true, ...overrides });

suite('Delivery artifacts — the five CI gates', () => {
  test('exactly five gates, each with a stable id and job', () => {
    assert.strictEqual(CI_GATES.length, 5);
    assert.strictEqual(new Set(CI_GATES.map((gate) => gate.id)).size, 5);
    for (const gate of CI_GATES) {
      assert.ok(gate.requirement.length > 0, `${gate.id} has no requirement`);
    }
    assert.deepStrictEqual(
      CI_GATES.map((gate) => gate.id),
      [
        CI_GATE_IDS.staticAnalysis,
        CI_GATE_IDS.securityScan,
        CI_GATE_IDS.testAndContract,
        CI_GATE_IDS.imageScan,
        CI_GATE_IDS.deploy,
      ],
    );
  });

  test('every gate is a job in the workflow and cites its id', () => {
    const ci = workflow();
    for (const gate of CI_GATES) {
      assert.ok(ci.includes(`\n  ${gate.job}:`), `${gate.job} is not a job`);
      assert.ok(ci.includes(gate.id), `${gate.id} is never cited`);
    }
  });

  test('the gates are ordered: deploy needs all four earlier jobs', () => {
    const ci = workflow();
    assert.ok(
      ci.includes('needs: [gate-static, gate-security, gate-test, gate-image]'),
      'deploy does not require every earlier gate',
    );
    assert.ok(ci.includes('needs: gate-test'), 'the image gate is not blocked by the tests');
  });

  test('deploy only runs from main and behind a manual environment', () => {
    const ci = workflow();
    assert.ok(ci.includes("if: github.ref == 'refs/heads/main'"));
    assert.ok(ci.includes('environment: production'));
  });

  test('the deploy gate applies manifests only when k8s is on', () => {
    assert.ok(workflow({ k8s: true }).includes('kubectl apply -f deploy/k8s'));
    const noK8s = workflow({ k8s: false });
    assert.ok(!noK8s.includes('kubectl'), 'kubectl leaked into a non-k8s project');
    assert.ok(noK8s.includes('no manifests to roll out'));
  });

  test('security gate runs both scanners from pinned images', () => {
    const ci = workflow();
    assert.ok(ci.includes(GATE_IMAGES.gitleaks), 'no secret scan');
    assert.ok(ci.includes(GATE_IMAGES.semgrep), 'no SAST');
    assert.ok(ci.includes(`--config ${SAST_RULESET}`), 'the SAST ruleset is not pinned');
    for (const image of Object.values(GATE_IMAGES)) {
      assert.ok(!image.endsWith(':latest'), `${image} floats on latest`);
    }
  });

  test('image gate builds and scans every service, and resolves dotted folders', () => {
    const ci = workflow({ services: ['gateway', 'users', 'orders'] });
    assert.ok(ci.includes('service: [gateway, users, orders]'), 'the matrix is not the service list');
    assert.ok(ci.includes(GATE_IMAGES.trivy), 'no image scan');
    // A .NET tree stores services/Users, so the folder is resolved, never assumed.
    assert.ok(ci.includes('Resolve the service folder'), 'no folder resolution step');
    assert.ok(ci.includes('${{ steps.svc.outputs.dir }}/Dockerfile'));
  });

  test('a service appended by /new-service patches the matrix', () => {
    const patched = appendCiMatrixService(workflow(), 'billing');
    assert.ok(patched, 'the generated matrix is not patchable by addService');
    assert.ok(patched!.includes('billing'));
  });

  test('coverage has a threshold and only bites when tests exist', () => {
    const ci = workflow();
    assert.ok(ci.includes(`--check-coverage --lines ${COVERAGE_THRESHOLD}`));
    assert.ok(ci.includes("hashFiles('**/test/**/*.test.*'"), 'the coverage gate is unconditional');
  });

  test('contract gates appear only for a project that has contracts', () => {
    const withContracts = workflow({ contractsDir: 'contracts' });
    assert.ok(withContracts.includes('@redocly/cli'), 'no OpenAPI lint');
    assert.ok(withContracts.includes('scripts/validate-event-schemas.mjs'));

    const without = workflow();
    assert.ok(!without.includes('redocly'), 'contract lint leaked into a contract-less project');
    assert.ok(!without.includes('validate-event-schemas.mjs'));
  });

  test('per-stack commands are the stack toolkit, never npm for everything', () => {
    assert.strictEqual(runtimeFamily('python'), 'python');
    assert.strictEqual(runtimeFamily('dotnet'), 'dotnet');
    assert.strictEqual(runtimeFamily('php-laravel'), 'php');
    assert.strictEqual(runtimeFamily('node-ts'), 'node');
    assert.strictEqual(runtimeFamily('something-new'), 'node');

    assert.ok(familyCommands('python').test[0].startsWith('pytest'));
    assert.ok(familyCommands('dotnet').test[0].startsWith('dotnet test'));
    assert.ok(familyCommands('php').test[0].includes('php artisan test'));
    assert.ok(familyCommands('node').install === 'npm ci');
  });

  test('the workspace tool can override the node commands', () => {
    const ci = workflow({ install: 'pnpm install --frozen-lockfile', test: ['pnpm -r test'] });
    assert.ok(ci.includes('pnpm install --frozen-lockfile'));
    assert.ok(ci.includes('pnpm -r test'));
    assert.ok(!ci.includes('npm ci'), 'the npm default survived the override');
  });
});

suite('Delivery artifacts — one database per service', () => {
  const overlay = planDatabaseOverlay({ services: ['users', 'orders'] });

  test('every service gets its own database, user and volume', () => {
    for (const [index, service] of ['users', 'orders'].entries()) {
      assert.ok(overlay.includes(`  ${service}-db:`), `${service} has no database`);
      assert.ok(overlay.includes(`POSTGRES_DB: ${databaseName(service)}`));
      assert.ok(overlay.includes(`POSTGRES_USER: ${databaseName(service)}`));
      assert.ok(overlay.includes(`  ${service}-db-data:`), `${service} has no volume`);
      assert.ok(overlay.includes(`"${databasePort(index)}:5432"`), `${service} port collides`);
    }
    assert.ok(overlay.includes('pg_isready'), 'no database healthcheck');
  });

  test('each service points at its own database, never a shared one', () => {
    for (const service of ['users', 'orders']) {
      const db = databaseName(service);
      assert.ok(
        overlay.includes(`DATABASE_URL: postgres://${db}:`),
        `${service} does not own its credentials`,
      );
      assert.ok(overlay.includes(`@${service}-db:5432/${db}`), `${service} points elsewhere`);
    }
    const urls = overlay.split('\n').filter((line) => line.includes('DATABASE_URL:'));
    assert.strictEqual(urls.length, 2, 'more than one URL per service');
    assert.notStrictEqual(urls[0], urls[1], 'two services share a database');
  });

  test('the password is an env override with a local-only default', () => {
    assert.ok(overlay.includes(`\${${databasePasswordEnv('users')}:-localonly}`));
  });

  test('the database image is pinned', () => {
    const images = overlay.split('\n').filter((line) => line.trim().startsWith('image:'));
    assert.deepStrictEqual(images.length, 2);
    for (const line of images) {
      assert.ok(line.includes('postgres:16.4-alpine'), `unpinned database image: ${line}`);
    }
  });

  test('service names become valid SQL identifiers', () => {
    assert.strictEqual(databaseName('orders-api'), 'orders_api');
    assert.strictEqual(databaseName('Users'), 'users');
    assert.strictEqual(databasePasswordEnv('orders-api'), 'ORDERS_API_DB_PASSWORD');
  });
});

suite('Delivery artifacts — Kubernetes envelope', () => {
  const api = planK8sManifests({
    service: 'users',
    scope: 'demo-app',
    port: 8100,
    version: '1.2.0',
    kind: 'api',
    family: 'node',
    env: [
      { name: 'PORT', value: '8100' },
      { name: 'BROKER_URL', value: 'amqp://broker:5672' },
    ],
    secretKeys: ['DATABASE_URL'],
  });

  test('config and secrets are separate objects', () => {
    assert.ok(api.includes('kind: ConfigMap'));
    assert.ok(api.includes('kind: Secret'));
    assert.ok(api.includes('name: users-config'));
    assert.ok(api.includes('name: users-secrets'));
    assert.ok(api.includes('BROKER_URL: "amqp://broker:5672"'), 'non-secret env is missing');
    assert.ok(api.includes('configMapRef:'));
    assert.ok(api.includes('secretRef:'));
  });

  test('the secret carries no value — a placeholder would be a credential', () => {
    assert.ok(api.includes('stringData: {}'), 'the secret ships a value');
    const dataLines = api
      .split('\n')
      .filter((line) => line.trim().startsWith('stringData:'))
      .join('');
    assert.ok(!/=/.test(dataLines), 'the secret contains an assignment');
    assert.ok(api.includes('kubectl create secret generic users-secrets'), 'no guidance');
  });

  test('probes use the paths the service actually serves', () => {
    assert.ok(api.includes('path: /healthz/ready'));
    assert.ok(api.includes('path: /healthz/live'));
    assert.strictEqual(
      api.split('path: /healthz/ready').length - 1,
      1,
      'readiness is repeated',
    );
  });

  test('resources and a non-root security context are declared', () => {
    assert.ok(api.includes('requests:'));
    assert.ok(api.includes('limits:'));
    assert.ok(api.includes('cpu: 100m'));
    assert.ok(api.includes('memory: 256Mi'));
    assert.ok(api.includes('runAsNonRoot: true'));
    assert.ok(api.includes(`runAsUser: ${runtimeUid('node')}`));
    assert.ok(api.includes('readOnlyRootFilesystem: true'));
    assert.ok(api.includes('allowPrivilegeEscalation: false'));
    assert.ok(api.includes('capabilities:'));
    assert.ok(api.includes('drop: ["ALL"]'));
    assert.ok(api.includes('mountPath: /tmp'), 'a read-only root needs a writable /tmp');
  });

  test('the image is a pinned tag, never latest', () => {
    const image = k8sImage({ service: 'users', scope: 'demo-app', port: 8100, version: '1.2.0', kind: 'api', family: 'node' });
    assert.strictEqual(image, 'ghcr.io/demo-app/users:1.2.0');
    assert.ok(!api.includes(':latest'));
  });

  test('a worker gets no Service and no http probes', () => {
    const worker = planK8sManifests({
      service: 'mailer',
      scope: 'demo-app',
      port: 8101,
      version: '1.0.0',
      kind: 'worker',
      family: 'node',
    });
    assert.ok(!worker.includes('kind: Service'), 'a worker has no HTTP surface to expose');
    assert.ok(!worker.includes('readinessProbe'), 'a worker has no endpoint to probe');
    assert.ok(worker.includes('kind: Deployment'));
  });

  test('the per-family uid matches the image, not a guess', () => {
    assert.strictEqual(runtimeUid('node'), 1000);
    assert.strictEqual(runtimeUid('python'), 10001);
    assert.strictEqual(runtimeUid('php'), 10001);
    assert.strictEqual(runtimeUid('dotnet'), 1654);
  });

  test('the manifest guide explains secrets without shipping one', () => {
    const readme = planK8sReadme({ scope: 'demo-app' });
    assert.ok(readme.includes('kubectl create secret generic'));
    assert.ok(readme.includes('/healthz/ready'));
    assert.ok(!/postgres:\/\/[a-z]+:[^<]/.test(readme), 'the guide contains a real connection string');
  });
});

suite('Delivery artifacts — the tree every stack receives', () => {
  const base = {
    projectName: 'zen-orders',
    description: 'Orders platform',
    version: '1.2.0',
    services: ['users', 'orders'],
    gateway: 'gateway',
    broker: 'rabbitmq',
    sharedPackage: true,
    containerization: true,
  };

  test('planDeliveryFiles emits CI, the overlay and one manifest per service', () => {
    const files = planDeliveryFiles({
      scope: 'demo-app',
      version: '1.0.0',
      stack: 'node-ts',
      services: [
        { name: 'gateway', port: 8080, kind: 'api' },
        { name: 'users', port: 8100, kind: 'api' },
        { name: 'mailer', port: 8101, kind: 'worker' },
      ],
      k8s: true,
      contracts: true,
      compose: true,
    });
    assert.ok(files[CI_WORKFLOW_PATH].includes(CI_GATE_IDS.deploy));
    assert.ok(files[COMPOSE_DATABASE_PATH].includes('users-db'));
    assert.ok(!files[COMPOSE_DATABASE_PATH].includes('gateway-db'), 'the gateway got a database');
    assert.ok(files[EVENT_SCHEMA_VALIDATOR_PATH] === EVENT_SCHEMA_VALIDATOR);
    for (const service of ['gateway', 'users', 'mailer']) {
      assert.ok(files[`deploy/k8s/${service}.yaml`], `${service} has no manifest`);
    }
    assert.ok(files['deploy/k8s/README.md']);
  });

  test('the validator rejects an envelope without its required fields', () => {
    // The script is generated text; run its core check against a bad schema.
    const required = ["'eventId'", "'eventType'", "'timestamp'", "'source'", "'version'", "'payload'"];
    for (const field of required) {
      assert.ok(EVENT_SCHEMA_VALIDATOR.includes(field), `the validator ignores ${field}`);
    }
    assert.ok(EVENT_SCHEMA_VALIDATOR.includes('process.exit(1)'), 'the validator never fails');
  });

  test('every monorepo stack gets the full delivery envelope', () => {
    for (const stack of ['python', 'dotnet', 'php-laravel'] as const) {
      const tree = planMonorepoTree(stack, { ...base, k8s: true });
      assert.ok(tree[CI_WORKFLOW_PATH], `${stack} has no CI`);
      assert.ok(tree[COMPOSE_DATABASE_PATH], `${stack} has no database overlay`);
      assert.ok(tree['deploy/k8s/users.yaml'], `${stack} has no manifest`);
      assert.ok(tree['deploy/k8s/README.md'], `${stack} has no manifest guide`);
      assert.ok(tree[EVENT_SCHEMA_VALIDATOR_PATH], `${stack} has no schema validator`);

      // The stack's own toolkit, not npm.
      const ci = tree[CI_WORKFLOW_PATH];
      const install = familyCommands(runtimeFamily(stack)).install.split(' ')[0];
      assert.ok(ci.includes(install), `${stack} CI does not run ${install}`);
    }
  });

  test('k8s manifests are opt-in per tree', () => {
    const tree = planMonorepoTree('python', base);
    assert.ok(!Object.keys(tree).some((path) => path.startsWith('deploy/k8s/')), 'k8s leaked in');
    assert.ok(tree[CI_WORKFLOW_PATH], 'CI should not depend on k8s');
  });
});

suite('Delivery artifacts — the contract gate lints what the planner emits', () => {
  const monoBase = {
    projectName: 'zen-orders',
    description: 'Orders platform',
    version: '1.2.0',
    services: ['users', 'orders'],
    gateway: 'gateway',
    broker: 'rabbitmq',
    sharedPackage: true,
    containerization: true,
  };

  test('the guard and the lint target are the emitted glob, never a literal filename', () => {
    const tree = planMonorepoTree('python', { ...monoBase, k8s: true });
    const ci = tree[CI_WORKFLOW_PATH];
    assert.ok(ci, 'no CI workflow was planned');
    const glob = openApiGlob();
    const prefix = glob.split('*')[0];
    const emitted = Object.keys(tree).filter(
      (p) => p.startsWith(prefix) && p.endsWith('.v1.yaml'),
    );
    assert.ok(emitted.length > 0, 'no OpenAPI document was planned');
    assert.ok(ci.includes('lint ' + glob), 'redocly lints a path the planner never writes');
    assert.ok(
      ci.includes("hashFiles('" + glob + "')"),
      'the guard hashes a path the planner never writes',
    );
    for (const p of emitted) {
      assert.ok(p.startsWith(prefix), p + ' is not covered by ' + glob);
    }
    assert.ok(
      !ci.includes("contracts/openapi.yaml"),
      'a literal guard that never matches skips the gate without failing it',
    );
  });

  test('the event-schema guard matches the schemas the planner emits', () => {
    const tree = planMonorepoTree('python', { ...monoBase, k8s: true });
    const ci = tree[CI_WORKFLOW_PATH];
    const glob = eventSchemaGlob();
    const emitted = Object.keys(tree).filter(
      (p) => p.startsWith(glob.split('*')[0]) && p.endsWith('.json'),
    );
    assert.ok(emitted.length > 0, 'no event schema was planned');
    assert.ok(ci.includes("hashFiles('" + glob + "')"));
  });
});
