/**
 * ZEN standards — the clause catalogue and the `AGENTS.md` that states it.
 *
 * Why this module exists: the earlier phases made the handbook's §4.2/§4.3
 * clauses true in the *emitted files*, but nothing told the agent working inside
 * the scaffolded repository that those rules are binding. `AGENTS.md` is the one
 * file every coding agent reads, so the clause ids live there, each beside the
 * artifact that satisfies it — a rule with no artifact is folklore, and an
 * artifact with no rule gets refactored away by the first agent that finds it
 * inconvenient.
 *
 * Mirrors the other artifact modules: pure data + pure functions, no `fs`, no
 * `vscode`, so every stack planner can call it directly.
 */

import { CI_GATE_IDS, runtimeFamily, type RuntimeFamily } from './deliveryArtifacts';

/**
 * The managed zone. Deliberately *not* ADO Code's own `ado-code:managed` markers:
 * a scaffolded repository has no repository-understanding cache, and its ADO Code
 * sync rewrites that block with `What This Is` / `Build & Test` / `Project
 * Structure`. Sharing the markers would let that sync delete the standards.
 */
export const ZEN_STANDARDS_START = '<!-- zen-standards:begin -->';
export const ZEN_STANDARDS_END = '<!-- zen-standards:end -->';

/**
 * Clause ids, mirroring the handbook (`REPO` = §4.1, `CON` = §4.2, `CI` = §4.3).
 *
 * The id is the join key between this file, the emitted `ARCHITECTURE.md`, the CI
 * job names and the `doc-tester` evidence reports. Rename one and the traceability
 * chain breaks silently, so the ids are constants rather than literals at each
 * use site.
 */
export const CLAUSE_IDS = {
  repo: 'ZEN-STD-REPO-01',
  container: 'ZEN-STD-CON-01',
  contract: 'ZEN-STD-CON-02',
  observability: 'ZEN-STD-CON-03',
  lifecycle: 'ZEN-STD-CON-04',
  security: 'ZEN-STD-CON-05',
  resilience: 'ZEN-STD-CON-06',
  ciStatic: 'ZEN-STD-CI-01',
  ciTest: 'ZEN-STD-CI-02',
  ciBuild: 'ZEN-STD-CI-03',
  ciImage: 'ZEN-STD-CI-04',
  ciDeploy: 'ZEN-STD-CI-05',
  ciDatabase: 'ZEN-STD-CI-06',
  ciK8s: 'ZEN-STD-CI-07',
} as const;

export type ClauseId = (typeof CLAUSE_IDS)[keyof typeof CLAUSE_IDS];

export interface StandardsClause {
  /** `ZEN-STD-*` — citable from a PR, an ADR or an evidence report. */
  readonly id: string;
  /** Imperative one-liner an agent can check its own diff against. */
  readonly rule: string;
  /** Where the rule is already true in this repository, or why it is not yet. */
  readonly home: string;
}

/**
 * Where each runtime rule is satisfied, per toolkit. `node` is the only family
 * that ships a shared TypeScript package, so it is the only one where CON-03/04/06
 * resolve to reusable modules — claiming otherwise in the other three would be the
 * kind of documentation that rots the moment someone looks.
 */
/**
 * CON-05 is the one clause whose artifact differs by more than a file name: the
 * node stack validates the JWT in the shared package, while python, .NET and PHP
 * re-verify the edge stamp with their own standard library (securityEdgeGuards.ts).
 * All four fail closed — an unset EDGE_AUTH_REQUIRED means required.
 */
const SECURITY_HOME: Record<RuntimeFamily, string> = {
  node: '`packages/shared/src/auth.ts`, `secrets.ts`; `deploy/k8s/*.yaml` Secret (empty `stringData`)',
  python: '`services/*/app/security.py`; `.env.example` placeholders only',
  dotnet: '`services/*/Security/EdgeAuthMiddleware.cs`; `.env.example` placeholders only',
  php: '`services/*/app/Http/Middleware/VerifyEdgeIdentity.php`; `.env.example` placeholders only',
};

const OBSERVABILITY_HOME: Record<RuntimeFamily, string> = {
  node: '`packages/shared/src/logger.ts`, `correlation.ts`, `metrics.ts`',
  python: '`services/<name>/app/main.py` (structured log lines, `/metrics` counter)',
  dotnet: '`services/<Name>/Program.cs` (request log, `/metrics` counter)',
  php: '`services/<name>/bootstrap/app.php` (request log, `/metrics` route)',
};

const LIFECYCLE_HOME: Record<RuntimeFamily, string> = {
  node: '`packages/shared/src/health.ts`, `lifecycle.ts`',
  python: '`services/<name>/app/main.py` (readiness flips before shutdown)',
  dotnet: '`services/<Name>/Program.cs` (`ApplicationStopping` flips readiness)',
  php: '`services/<name>/bootstrap/app.php` (draining marker flips readiness)',
};

const RESILIENCE_HOME: Record<RuntimeFamily, string> = {
  node: '`packages/shared/src/resilience.ts` (timeout, retry, breaker, idempotency)',
  python: 'not scaffolded — implement per service before calling a dependency',
  dotnet: 'not scaffolded — implement per service before calling a dependency',
  php: 'not scaffolded — implement per service before calling a dependency',
};

/** Handbook §4.2 — the six runtime clauses. */
export function runtimeClauses(family: RuntimeFamily): readonly StandardsClause[] {
  return [
    {
      id: CLAUSE_IDS.container,
      rule:
        'Containers are multi-stage, run as a non-root user, declare a HEALTHCHECK and pin their base image to an exact version.',
      home: '`services/*/Dockerfile`',
    },
    {
      id: CLAUSE_IDS.contract,
      rule:
        'Contract first: no route exists without a document in `contracts/`, every service is served under `/api/v1`, events use one versioned envelope.',
      home: '`contracts/openapi/*.v1.yaml`, `contracts/events/*.json`',
    },
    {
      id: CLAUSE_IDS.observability,
      rule:
        'Logs are one JSON object per line on stdout, `/metrics` exposes Prometheus text, and `X-Correlation-ID` is reused or minted once at the edge and forwarded.',
      home: OBSERVABILITY_HOME[family],
    },
    {
      id: CLAUSE_IDS.lifecycle,
      rule:
        '`/healthz/live` reports the process, `/healthz/ready` reports the dependency check and withdraws before shutdown; SIGTERM drains in-flight work.',
      home: LIFECYCLE_HOME[family],
    },
    {
      id: CLAUSE_IDS.security,
      rule:
        'JWTs are validated at the edge, secrets come from the environment or a secret store, and nothing credential-shaped is committed.',
      home: SECURITY_HOME[family],
    },
    {
      id: CLAUSE_IDS.resilience,
      rule:
        'Every outbound call has a timeout, bounded retries with jitter and a circuit breaker; writes accept and honour an `Idempotency-Key`.',
      home: RESILIENCE_HOME[family],
    },
  ];
}

/** Handbook §4.3 — the gates a pull request has to pass. */
export function ciClauses(): readonly StandardsClause[] {
  return [
    {
      id: CLAUSE_IDS.ciStatic,
      rule: `Lint + typecheck, secret scan (gitleaks) and SAST (Semgrep) must be clean — ${CI_GATE_IDS.staticAnalysis} and ${CI_GATE_IDS.securityScan}.`,
      home: '`.github/workflows/ci.yml` · jobs `gate-static`, `gate-security`',
    },
    {
      id: CLAUSE_IDS.ciTest,
      rule: `Unit tests, contract lint (Redocly) and event-schema validation must pass with coverage at or above the gate — ${CI_GATE_IDS.testAndContract}.`,
      home: '`.github/workflows/ci.yml` · job `gate-test`, `scripts/validate-event-schemas.mjs`',
    },
    {
      id: CLAUSE_IDS.ciBuild,
      rule: 'Every service image must build from the committed Dockerfile; a build that only works locally is a red gate.',
      home: '`.github/workflows/ci.yml` · job `gate-image` (build step)',
    },
    {
      id: CLAUSE_IDS.ciImage,
      rule: `The built image is scanned and fails on HIGH or CRITICAL findings — ${CI_GATE_IDS.imageScan}.`,
      home: '`.github/workflows/ci.yml` · job `gate-image` (Trivy step)',
    },
    {
      id: CLAUSE_IDS.ciDeploy,
      rule: `Deployment runs only from \`main\` after all four gates pass and only against the \`production\` environment — ${CI_GATE_IDS.deploy}.`,
      home: '`.github/workflows/ci.yml` · job `deploy`',
    },
    {
      id: CLAUSE_IDS.ciDatabase,
      rule: 'A service that needs a store gets its own database — no shared schema, no cross-service table reads.',
      home: '`docker-compose.databases.yml` (one Postgres per domain service)',
    },
    {
      id: CLAUSE_IDS.ciK8s,
      rule: 'Manifests declare resources, run non-root with a read-only root filesystem, and probe the paths the app actually serves.',
      home: '`deploy/k8s/*.yaml` (ConfigMap, Secret, Deployment, Service)',
    },
  ];
}

/** Everything `planStandardsAgentsMd` needs; a subset of the monorepo tree plan. */
export interface StandardsAgentsPlan {
  readonly projectName: string;
  readonly description: string;
  /** Catalogue stack id (`node-ts`, `python`, …) — selects the family. */
  readonly stack: string;
  readonly services: readonly string[];
  /** Gateway folder name, or `''` for none. */
  readonly gateway: string;
}

function table(clauses: readonly StandardsClause[]): string[] {
  return [
    '| Clause | Rule | Where it is already true |',
    '|---|---|---|',
    ...clauses.map((clause) => `| \`${clause.id}\` | ${clause.rule} | ${clause.home} |`),
  ];
}

/**
 * Render the repository's `AGENTS.md`.
 *
 * The managed block is the load-bearing part: it is generated from the clause
 * catalogue, so a clause id cannot exist in the handbook and be missing here. The
 * sections around it are ordinary prose the team is expected to extend.
 */
export function planStandardsAgentsMd(plan: StandardsAgentsPlan): string {
  const family = runtimeFamily(plan.stack);
  const serviceList = plan.services.length ? plan.services.join(', ') : '(none yet)';
  const gateway = plan.gateway ? plan.gateway : '(none — services are exposed directly)';

  const lines: string[] = [
    `# AGENTS.md — ${plan.projectName}`,
    '',
    plan.description,
    '',
    'Read this before your first edit. The block between the `zen-standards` comments is',
    'generated from the ZEN engineering standard and is rewritten when the scaffold is',
    'regenerated — put your own notes outside it.',
    '',
    ZEN_STANDARDS_START,
    '## ZEN engineering standards (binding)',
    '',
    'Every change must keep these clauses true. If a clause cannot be satisfied, say so in',
    'the response instead of working around it — the CI gates will reject the change anyway.',
    '',
    '### Runtime (handbook §4.2)',
    '',
    ...table(runtimeClauses(family)),
    '',
    '### CI (handbook §4.3) — a red gate blocks the merge',
    '',
    ...table(ciClauses()),
    '',
    '### Repository layout (handbook §4.1, amended for a monorepo)',
    '',
    '- `services/<name>/` — one deployable per domain service; no service reads another\'s tables.',
    `- \`services/${plan.gateway || 'gateway'}/\` — the only process exposed to clients; it forwards \`/api/v1/*\` verbatim.`,
    '- `contracts/` — OpenAPI document per service plus one JSON Schema per published event.',
    '- `packages/shared/` — code every TypeScript service compiles in; never a runtime dependency between services.',
    '- `deploy/k8s/`, `docker-compose.yml` — deployment surface; the database overlay is opt-in.',
    '',
    '### What an agent must not do here',
    '',
    '- Invent a service, route or event without adding its contract to `contracts/` in the same change.',
    '- Call another service over the network without a timeout, or retry a non-idempotent write.',
    '- Edit `contracts/`, the CI workflow or a Dockerfile to make a red gate pass.',
    '- Commit a credential, or pin a base image to `latest`.',
    '',
    '### Project structure',
    '',
    `Services: ${serviceList}`,
    `Gateway: ${gateway}`,
    `Stack: ${plan.stack}`,
    '',
    ZEN_STANDARDS_END,
    '',
    '## Build & Test',
    '',
    `Install, run and test from the repository root — the exact commands per package are in`,
    `\`README.md\`. The commands CI runs are the ones to trust: ${testCommand(family)}.`,
    '',
  ];

  return lines.join('\n');
}

/** The test command the tree's own CI gate runs — safe to name in prose. */
function testCommand(family: RuntimeFamily): string {
  switch (family) {
    case 'python':
      return '`pytest`';
    case 'dotnet':
      return '`dotnet test`';
    case 'php':
      return '`php artisan test`';
    case 'node':
    default:
      return '`npm test`';
  }
}

/**
 * Add a service to the `Services:` line inside the managed block.
 *
 * `/new-service` extends an existing repository, so it must not rewrite the whole
 * file — but a service missing from the standards block is a service the next
 * agent does not know exists. Patching one line keeps the team's prose intact.
 *
 * Returns null when the file has no managed block, no `Services:` line, or the
 * service is already listed; the caller then reports nothing written.
 */
export function appendStandardsService(existing: string, service: string): string | null {
  const start = existing.indexOf(ZEN_STANDARDS_START);
  const end = existing.indexOf(ZEN_STANDARDS_END, start);
  if (start === -1 || end === -1) {
    return null;
  }

  const block = existing.slice(start, end);
  const line = /^Services: (.*)$/m.exec(block);
  if (!line) {
    return null;
  }

  const listed = line[1].trim();
  const names = listed && listed !== '(none yet)' ? listed.split(',').map((name) => name.trim()) : [];
  if (names.includes(service)) {
    return null;
  }
  names.push(service);

  const nextBlock = block.replace(/^Services: .*$/m, `Services: ${names.join(', ')}`);
  return `${existing.slice(0, start)}${nextBlock}${existing.slice(end)}`;
}

/**
 * Replace the managed block inside an existing `AGENTS.md`, keeping everything
 * the team wrote around it. Used by `/new-service`, which must not clobber notes.
 *
 * Returns the original content unchanged when the markers are absent or out of
 * order — an unmarked file is the team's, and guessing where a block belongs in
 * it would lose their edits.
 */
export function replaceStandardsBlock(existing: string, block: string): string {
  const start = existing.indexOf(ZEN_STANDARDS_START);
  const end = existing.indexOf(ZEN_STANDARDS_END, start);
  if (start === -1 || end === -1) {
    return existing;
  }
  const inner = block.slice(
    block.indexOf(ZEN_STANDARDS_START),
    block.indexOf(ZEN_STANDARDS_END) + ZEN_STANDARDS_END.length
  );
  return `${existing.slice(0, start)}${inner}${existing.slice(end + ZEN_STANDARDS_END.length)}`;
}
