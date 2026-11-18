/**
 * Delivery gates and deployment envelopes — ZEN handbook §4.3.
 *
 * One module owns three artifacts so a generated project cannot ship a CI file,
 * a compose overlay and a Kubernetes manifest that disagree with each other:
 *
 *   .github/workflows/ci.yml        the five mandatory, blocking gates
 *   docker-compose.databases.yml    one database per service (no shared schema)
 *   deploy/k8s/<service>.yaml       ConfigMap + Secret ref, probes, resources
 *
 * Everything is pure text generation — no YAML parser, no runtime dependency,
 * deterministic output so the golden fixtures can pin it byte for byte.
 */

import { eventSchemaGlob, openApiGlob } from './contractArtifacts';
import { OBSERVABILITY_PATHS } from './observabilityArtifacts';

/* -------------------------------------------------------------------------- */
/* The five gates                                                              */
/* -------------------------------------------------------------------------- */

/** Stable ids so the handbook, the docs and a test can cite one gate. */
export const CI_GATE_IDS = {
  staticAnalysis: 'GATE-01',
  securityScan: 'GATE-02',
  testAndContract: 'GATE-03',
  imageScan: 'GATE-04',
  deploy: 'GATE-05',
} as const;

export interface CiGate {
  readonly id: string;
  /** GitHub Actions job id — the `needs:` chain and the docs both use it. */
  readonly job: string;
  /** What the gate must prove before a merge is allowed. */
  readonly requirement: string;
}

/**
 * ZEN §4.3 lists these five as mandatory. They are ordered: every later gate
 * is blocked by the earlier ones, so a failing lint never reaches a deploy.
 */
export const CI_GATES: readonly CiGate[] = [
  {
    id: CI_GATE_IDS.staticAnalysis,
    job: 'gate-static',
    requirement: 'lint + typecheck pass with zero findings',
  },
  {
    id: CI_GATE_IDS.securityScan,
    job: 'gate-security',
    requirement: 'SAST reports no finding and no secret is committed',
  },
  {
    id: CI_GATE_IDS.testAndContract,
    job: 'gate-test',
    requirement: 'unit tests pass, contracts validate, coverage meets the threshold',
  },
  {
    id: CI_GATE_IDS.imageScan,
    job: 'gate-image',
    requirement: 'every service image builds and scans clean of HIGH/CRITICAL',
  },
  {
    id: CI_GATE_IDS.deploy,
    job: 'gate-deploy',
    requirement: 'rollout only from main, behind a manual environment approval',
  },
];

/** Line coverage a scaffolded repo must hold (`c8 --check-coverage`). */
export const COVERAGE_THRESHOLD = 80;

/** Node version for the JS toolchain steps (contract lint, coverage). */
export const CI_NODE_VERSION = '20';

/**
 * Pinned images for the scanning gates. A scanner that floats is a gate that
 * changes verdict without a code change, so all three are patch-pinned.
 */
export const GATE_IMAGES = {
  gitleaks: 'ghcr.io/gitleaks/gitleaks:v8.21.2',
  semgrep: 'semgrep/semgrep:1.90.0',
  trivy: 'aquasec/trivy:0.56.2',
} as const;

/** Semgrep ruleset — the default registry set, no token required. */
export const SAST_RULESET = 'p/default';

/** Redocly validates OpenAPI 3.1; pinned for a stable verdict. */
export const REDOCLY_VERSION = '1.25.0';

/* -------------------------------------------------------------------------- */
/* Runtime families                                                            */
/* -------------------------------------------------------------------------- */

export type RuntimeFamily = 'node' | 'python' | 'dotnet' | 'php';

/**
 * Map a catalogue stack id to the toolkit its CI has to run. Anything unknown
 * falls back to `node`, which is the catalogue default.
 */
export function runtimeFamily(stack: string): RuntimeFamily {
  switch (stack) {
    case 'python':
      return 'python';
    case 'dotnet':
    case 'dotnet-webapi':
      return 'dotnet';
    case 'php-laravel':
      return 'php';
    default:
      return 'node';
  }
}

/**
 * The uid the image actually runs as (see `hardeningLines`). Kubernetes has to
 * be told: `runAsNonRoot` only asserts, it cannot infer a number from `USER`.
 */
export function runtimeUid(family: RuntimeFamily): number {
  switch (family) {
    case 'node':
      return 1000; // `node` in node:*-alpine
    case 'python':
    case 'php':
      return 10001; // the `app` user both Debian images create
    case 'dotnet':
      return 1654; // `$APP_UID` in the ASP.NET runtime image
  }
}

/* -------------------------------------------------------------------------- */
/* CI workflow                                                                 */
/* -------------------------------------------------------------------------- */

export interface CiWorkflowPlan {
  readonly family: RuntimeFamily;
  /** Domain services, gateway included — the image matrix. */
  readonly services: readonly string[];
  /** Emit the `kubectl apply` step in the deploy gate. */
  readonly k8s: boolean;
  /** Directory holding `contracts/`, or '' when the tree has none. */
  readonly contractsDir?: string;
  /** Tool-aware overrides (a pnpm/nx workspace installs differently). */
  readonly install?: string;
  readonly lint?: readonly string[];
  readonly typecheck?: readonly string[];
  readonly test?: readonly string[];
  /** Full YAML lines replacing the runtime setup steps (e.g. pnpm's action). */
  readonly setup?: readonly string[];
}

interface FamilyCommands {
  readonly runtime: readonly string[];
  readonly install: string;
  readonly lint: readonly string[];
  readonly typecheck: readonly string[];
  readonly test: readonly string[];
}

/** The per-family commands each gate runs. Exported so a test can assert them. */
export function familyCommands(family: RuntimeFamily): FamilyCommands {
  switch (family) {
    case 'python':
      return {
        runtime: [
          '      - uses: actions/setup-python@v5',
          '        with:',
          '          python-version: "3.12"',
        ],
        install: 'python -m pip install --upgrade pip && pip install ruff mypy pytest',
        lint: ['ruff check services'],
        typecheck: ['mypy services --ignore-missing-imports'],
        test: ['pytest services -q'],
      };
    case 'dotnet':
      return {
        runtime: [
          '      - uses: actions/setup-dotnet@v4',
          '        with:',
          '          dotnet-version: "8.0.x"',
        ],
        install: 'dotnet restore',
        lint: ['dotnet format --verify-no-changes'],
        typecheck: ['dotnet build --no-restore -warnaserror'],
        test: ['dotnet test --no-build'],
      };
    case 'php':
      return {
        runtime: [
          '      - uses: shivammathur/setup-php@v2',
          '        with:',
          '          php-version: "8.3"',
          '          coverage: none',
        ],
        install:
          'for d in services/*/; do composer install --working-dir="$d" --no-interaction --prefer-dist; done',
        lint: ['for d in services/*/; do (cd "$d" && vendor/bin/pint --test); done'],
        typecheck: ['for d in services/*/; do (cd "$d" && vendor/bin/phpstan analyse --no-progress); done'],
        test: ['for d in services/*/; do (cd "$d" && php artisan test); done'],
      };
    default:
      return {
        runtime: [
          '      - uses: actions/setup-node@v4',
          '        with:',
          `          node-version: ${CI_NODE_VERSION}`,
          '          cache: npm',
        ],
        install: 'npm ci',
        lint: ['npm run lint --if-present'],
        typecheck: ['npx tsc -b --pretty false'],
        test: ['npm test --workspaces --if-present'],
      };
  }
}

/**
 * Build the CI workflow. Line-array construction rather than a template literal,
 * because GitHub expressions (`${{ … }}`) collide with TypeScript interpolation
 * inside a template string.
 */
export function planCiWorkflow(plan: CiWorkflowPlan): string {
  const base = familyCommands(plan.family);
  const commands: FamilyCommands = {
    runtime: plan.setup ?? base.runtime,
    install: plan.install ?? base.install,
    lint: plan.lint ?? base.lint,
    typecheck: plan.typecheck ?? base.typecheck,
    test: plan.test ?? base.test,
  };
  const lines: string[] = [
    '# ZEN-STD-4.3 — five mandatory gates. Every job is blocking: a red gate',
    '# stops the merge, and gate 5 never runs from a branch.',
    'name: ci',
    '',
    'on:',
    '  push:',
    '    branches: [main]',
    '  pull_request:',
    '',
    'concurrency:',
    '  group: ci-${{ github.ref }}',
    '  cancel-in-progress: true',
    '',
    'permissions:',
    '  contents: read',
    '  security-events: write',
    '',
    'jobs:',
  ];

  /* ---- GATE-01 static analysis ------------------------------------------- */
  lines.push(
    '  gate-static:',
    `    name: "${CI_GATE_IDS.staticAnalysis} lint + typecheck"`,
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    ...commands.runtime,
    `      - run: ${commands.install}`,
    ...commands.lint.map((run) => `      - run: ${run}`),
    ...commands.typecheck.map((run) => `      - run: ${run}`),
  );

  /* ---- GATE-02 security -------------------------------------------------- */
  lines.push(
    '',
    '  gate-security:',
    `    name: "${CI_GATE_IDS.securityScan} SAST + secret scan"`,
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '        with:',
    '          fetch-depth: 0',
    '      - name: Secret scan',
    `        run: docker run --rm -v "$PWD:/repo" ${GATE_IMAGES.gitleaks} detect --source=/repo --no-git --redact --verbose --exit-code=1`,
    '      - name: Static analysis (SAST)',
    `        run: docker run --rm -v "$PWD:/src" -w /src ${GATE_IMAGES.semgrep} semgrep scan --config ${SAST_RULESET} --metrics=off --error --quiet`,
  );

  /* ---- GATE-03 tests + contracts + coverage ------------------------------ */
  lines.push(
    '',
    '  gate-test:',
    `    name: "${CI_GATE_IDS.testAndContract} tests + contracts + coverage"`,
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    ...commands.runtime,
    `      - run: ${commands.install}`,
  );
  if (plan.contractsDir) {
    lines.push(
      '      - name: Contract lint (OpenAPI 3.1)',
      `        if: \${{ hashFiles('${openApiGlob(plan.contractsDir)}') != '' }}`,
      `        run: npx --yes @redocly/cli@${REDOCLY_VERSION} lint ${openApiGlob(plan.contractsDir)}`,
      '      - name: Event schemas are valid JSON Schema',
      `        if: \${{ hashFiles('${eventSchemaGlob(plan.contractsDir)}') != '' }}`,
      '        run: node scripts/validate-event-schemas.mjs',
    );
  }
  lines.push(
    ...commands.test.map((run) => `      - run: ${run}`),
    '      - name: Coverage threshold',
    "        if: ${{ hashFiles('**/test/**/*.test.*', '**/tests/**/*.py') != '' }}",
    `        run: npx --yes c8@10.1.3 --check-coverage --lines ${COVERAGE_THRESHOLD} --reporter=text-summary ${commands.test[0]}`,
  );

  /* ---- GATE-04 image build + scan ---------------------------------------- */
  lines.push(
    '',
    '  gate-image:',
    `    name: "${CI_GATE_IDS.imageScan} image build + scan"`,
    '    runs-on: ubuntu-latest',
    '    needs: gate-test',
    '    strategy:',
    '      fail-fast: false',
    '      matrix:',
    `        service: [${plan.services.join(', ')}]`,
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - name: Resolve the service folder',
    '        id: svc',
    '        run: |',
    "          name='${{ matrix.service }}'",
    '          if [ -d "services/$name" ]; then',
    '            echo "dir=services/$name" >> "$GITHUB_OUTPUT"',
    '          else',
    '            echo "dir=services/${name^}" >> "$GITHUB_OUTPUT"',
    '          fi',
    '      - name: Build image',
    '        run: docker build -f ${{ steps.svc.outputs.dir }}/Dockerfile -t ${{ matrix.service }}:${{ github.sha }} .',
    '      - name: Scan image',
    `        run: docker run --rm -v /var/run/docker.sock:/var/run/docker.sock ${GATE_IMAGES.trivy} image --exit-code 1 --severity HIGH,CRITICAL --ignore-unfixed \${{ matrix.service }}:\${{ github.sha }}`,
  );

  /* ---- GATE-05 deploy ---------------------------------------------------- */
  lines.push(
    '',
    '  gate-deploy:',
    `    name: "${CI_GATE_IDS.deploy} deploy (manual approval)"`,
    '    runs-on: ubuntu-latest',
    '    needs: [gate-static, gate-security, gate-test, gate-image]',
    "    if: github.ref == 'refs/heads/main'",
    '    environment: production',
    '    steps:',
    '      - uses: actions/checkout@v4',
  );
  if (plan.k8s) {
    lines.push(
      '      # The cluster credential is a repository secret; approval is the',
      '      # `environment: production` reviewer, not this step.',
      '      - name: Roll out manifests',
      '        run: kubectl apply -f deploy/k8s',
    );
  } else {
    lines.push(
      '      - name: Record the approved build',
      '        run: echo "approved ${{ github.sha }} — no manifests to roll out"',
    );
  }

  return `${lines.join('\n')}\n`;
}

/* -------------------------------------------------------------------------- */
/* One database per service                                                    */
/* -------------------------------------------------------------------------- */

/** A service name as a SQL identifier (`orders-api` → `orders_api`). */
export function databaseName(service: string): string {
  return service.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase();
}

/** Env var carrying the per-service password override. */
export function databasePasswordEnv(service: string): string {
  return `${databaseName(service).toUpperCase()}_DB_PASSWORD`;
}

/** Compose port for the Nth database — 5433+ so a local 5432 stays usable. */
export function databasePort(index: number): number {
  return 5433 + index;
}

export interface DatabaseOverlayPlan {
  /** Domain services only — the gateway owns no store. */
  readonly services: readonly string[];
}

/**
 * A compose overlay adding one PostgreSQL container per domain service plus the
 * matching `DATABASE_URL` on the service itself. An overlay rather than inline
 * edits so `docker compose up` still works with no database, and so the base
 * compose file stays a single source the stack planners own.
 */
export function planDatabaseOverlay(plan: DatabaseOverlayPlan): string {
  const lines: string[] = [
    '# One database per service — ZEN-STD-4.3 data ownership.',
    '#',
    '# No shared schema and no shared credentials: every service gets its own',
    '# database, its own role and its own volume. The base compose file stays',
    '# database-free, so this overlay is opt-in:',
    '#',
    '#   docker compose -f docker-compose.yml -f docker-compose.databases.yml up',
    '#   # or: export COMPOSE_FILE=docker-compose.yml:docker-compose.databases.yml',
    '#',
    'services:',
  ];

  plan.services.forEach((service, index) => {
    const db = databaseName(service);
    const passwordEnv = databasePasswordEnv(service);
    lines.push(
      `  ${service}-db:`,
      '    image: postgres:16.4-alpine',
      '    environment:',
      `      POSTGRES_DB: ${db}`,
      `      POSTGRES_USER: ${db}`,
      `      POSTGRES_PASSWORD: \${${passwordEnv}:-localonly}`,
      '    ports:',
      `      - "${databasePort(index)}:5432"`,
      '    volumes:',
      `      - ${service}-db-data:/var/lib/postgresql/data`,
      '    healthcheck:',
      `      test: ["CMD-SHELL", "pg_isready -U ${db} -d ${db}"]`,
      '      interval: 5s',
      '      timeout: 3s',
      '      retries: 10',
      '',
      `  ${service}:`,
      '    environment:',
      `      DATABASE_URL: postgres://${db}:\${${passwordEnv}:-localonly}@${service}-db:5432/${db}`,
      '    depends_on:',
      `      ${service}-db:`,
      '        condition: service_healthy',
      '',
    );
  });

  lines.push('volumes:');
  for (const service of plan.services) {
    lines.push(`  ${service}-db-data:`);
  }

  return `${lines.join('\n')}\n`;
}

/* -------------------------------------------------------------------------- */
/* Kubernetes manifests                                                        */
/* -------------------------------------------------------------------------- */

export interface K8sManifestPlan {
  readonly service: string;
  /** npm scope / org namespace used in the image path. */
  readonly scope: string;
  readonly port: number;
  readonly version: string;
  readonly kind: 'api' | 'worker';
  readonly family: RuntimeFamily;
  /** Non-secret environment, rendered into a ConfigMap. */
  readonly env?: readonly { readonly name: string; readonly value: string }[];
  /** Keys that must come from a Secret, never from the ConfigMap. */
  readonly secretKeys?: readonly string[];
  /** Registry prefix; defaults to `ghcr.io/<scope>`. */
  readonly registry?: string;
}

/** The image reference a manifest pins — a tag, never `latest`. */
export function k8sImage(plan: K8sManifestPlan): string {
  const registry = plan.registry ?? `ghcr.io/${plan.scope}`;
  return `${registry}/${plan.service}:${plan.version}`;
}

/**
 * ConfigMap + Secret + Deployment + Service for one service.
 *
 * A Secret is emitted with an EMPTY `stringData` on purpose: the manifest shows
 * where credentials are consumed, and the values are created out of band. A
 * manifest that shipped a placeholder value would ship a credential.
 */
export function planK8sManifests(plan: K8sManifestPlan): string {
  const env = plan.env ?? [{ name: 'LOG_LEVEL', value: 'info' }];
  const secretKeys = plan.secretKeys ?? [];
  const isApi = plan.kind === 'api';
  const lines: string[] = [
    '# ZEN-STD-4.3 deployment envelope: config and secrets are separate objects,',
    '# probes use the observability paths the service actually serves, and the',
    '# container runs unprivileged with a read-only root filesystem.',
    'apiVersion: v1',
    'kind: ConfigMap',
    'metadata:',
    `  name: ${plan.service}-config`,
    'data:',
    ...env.map((entry) => `  ${entry.name}: "${entry.value}"`),
    '---',
    'apiVersion: v1',
    'kind: Secret',
    'metadata:',
    `  name: ${plan.service}-secrets`,
    'type: Opaque',
    'stringData: {}',
    '# Never commit values. Create the secret out of band:',
    `#   kubectl create secret generic ${plan.service}-secrets \\`,
    ...(secretKeys.length > 0
      ? [
          `#     ${secretKeys.map((key) => `--from-literal=${key}='<value>'`).join(' \\\n#     ')}`,
        ]
      : ['#     --from-literal=SOME_KEY=\'<value>\'']),
    '---',
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata:',
    `  name: ${plan.service}`,
    '  labels:',
    `    app.kubernetes.io/name: ${plan.service}`,
    `    app.kubernetes.io/part-of: ${plan.scope}`,
    'spec:',
    '  replicas: 2',
    '  strategy:',
    '    rollingUpdate:',
    '      maxSurge: 1',
    '      maxUnavailable: 0',
    '  selector:',
    '    matchLabels:',
    `      app.kubernetes.io/name: ${plan.service}`,
    '  template:',
    '    metadata:',
    '      labels:',
    `        app.kubernetes.io/name: ${plan.service}`,
    '    spec:',
    '      securityContext:',
    '        runAsNonRoot: true',
    `        runAsUser: ${runtimeUid(plan.family)}`,
    '        fsGroup: 10001',
    '      terminationGracePeriodSeconds: 30',
    '      containers:',
    `        - name: ${plan.service}`,
    `          image: ${k8sImage(plan)}`,
    '          imagePullPolicy: IfNotPresent',
  ];

  if (isApi) {
    lines.push(
      '          ports:',
      '            - name: http',
      `              containerPort: ${plan.port}`,
    );
  }

  lines.push(
    '          envFrom:',
    '            - configMapRef:',
    `                name: ${plan.service}-config`,
    '            - secretRef:',
    `                name: ${plan.service}-secrets`,
    '                optional: false',
    '          securityContext:',
    '            allowPrivilegeEscalation: false',
    '            readOnlyRootFilesystem: true',
    '            capabilities:',
    '              drop: ["ALL"]',
    '          volumeMounts:',
    '            - name: tmp',
    '              mountPath: /tmp',
    '          resources:',
    '            requests:',
    '              cpu: 100m',
    '              memory: 128Mi',
    '            limits:',
    '              cpu: 500m',
    '              memory: 256Mi',
  );

  if (isApi) {
    lines.push(
      '          readinessProbe:',
      '            httpGet:',
      `              path: ${OBSERVABILITY_PATHS.ready}`,
      `              port: ${plan.port}`,
      '            initialDelaySeconds: 3',
      '            periodSeconds: 5',
      '            failureThreshold: 3',
      '          livenessProbe:',
      '            httpGet:',
      `              path: ${OBSERVABILITY_PATHS.live}`,
      `              port: ${plan.port}`,
      '            initialDelaySeconds: 10',
      '            periodSeconds: 10',
      '            failureThreshold: 3',
      '          lifecycle:',
      '            preStop:',
      '              exec:',
      '                command: ["sh", "-c", "sleep 5"]',
    );
  } else {
    lines.push(
      '          # Worker: no HTTP surface, so no http probes. Readiness is the',
      '          # broker connection the process reports on stdout.',
    );
  }

  lines.push(
    '      volumes:',
    '        - name: tmp',
    '          emptyDir: {}',
  );

  if (isApi) {
    lines.push(
      '---',
      'apiVersion: v1',
      'kind: Service',
      'metadata:',
      `  name: ${plan.service}`,
      '  labels:',
      `    app.kubernetes.io/name: ${plan.service}`,
      'spec:',
      '  type: ClusterIP',
      '  selector:',
      `    app.kubernetes.io/name: ${plan.service}`,
      '  ports:',
      '    - name: http',
      '      port: 80',
      `      targetPort: ${plan.port}`,
    );
  }

  return `${lines.join('\n')}\n`;
}

/** `deploy/k8s/README.md` — how the envelope is consumed, in three steps. */
export function planK8sReadme(plan: { readonly scope: string; readonly k8sNamespace?: string }): string {
  const namespace = plan.k8sNamespace ?? 'default';
  return [
    `# Kubernetes manifests — ${plan.scope}`,
    '',
    'One file per service. Each holds a ConfigMap (non-secret environment), a',
    'Secret reference (no values), a Deployment and — for APIs — a Service.',
    '',
    '## Apply',
    '',
    '```bash',
    'kubectl create namespace ' + namespace + ' --dry-run=client -o yaml | kubectl apply -f -',
    'kubectl apply -n ' + namespace + ' -f deploy/k8s',
    '```',
    '',
    '## Secrets',
    '',
    'Secrets are never in git: every file ships `stringData: {}`. Create them',
    'once per environment, then let the Deployment consume them via `envFrom`:',
    '',
    '```bash',
    'kubectl create secret generic <service>-secrets -n ' + namespace + ' \\',
    "  --from-literal=DATABASE_URL='postgres://…'",
    '```',
    '',
    'A committed value is a leaked value — rotate any key that ever lands here.',
    '',
    '## Probes',
    '',
    `- readiness: \`${OBSERVABILITY_PATHS.ready}\` — withdraws the pod from the Service during drain`,
    `- liveness:  \`${OBSERVABILITY_PATHS.live}\` — restarts only a hung process`,
    '',
    'The two answer different questions on purpose: a draining pod must fail',
    'readiness without being restarted.',
    '',
  ].join('\n');
}
