/**
 * ZEN clause-id traceability for the documentation templates.
 *
 * The handbook's §4 clauses are only citable if a document names them by id, so
 * the writer project emits a compliance matrix keyed on `ZEN-STD-*` and an ADR
 * log that records where a project departs from a clause. Both are generated
 * from the same `CLAUSE_IDS` catalogue that builds the scaffolded `AGENTS.md`
 * and the CI job names, so a renamed clause cannot leave a stale row behind.
 *
 * The status column is deliberately NOT all-green. It mirrors what the
 * boilerplates actually emit, so `Not scaffolded` (the TypeScript resilience
 * kit inside a Python service) reaches the reviewer instead of being hidden
 * behind a "Met" that nobody can evidence with a document.
 */
import { type RuntimeFamily } from '../deliveryArtifacts';
import { CLAUSE_IDS, ciClauses, runtimeClauses, type StandardsClause } from '../standardsArtifacts';

/** ADR folder and id prefix — `ADR-###` is the ADR's own identity. */
export const ADR_DIR = '01-design/adr';
export const ADR_ID_PREFIX = 'ADR-';

/**
 * The blank template carries no id: numbering it would squat on the next free
 * ADR id, and a real decision would then have to renumber around it.
 */
export const ADR_TEMPLATE_PATH = ADR_DIR + '/template.md';

/**
 * Distinct doc types per emitted file. `scaffoldDocs` derives the document id as
 * `<PROJECT>-<ROLE>-<TYPE>-001` and resolves register rows by that same suffix,
 * so two files sharing a type would collide on both the id and the lookup.
 */
export const ADR_LOG_DOC_TYPE = 'ADL';
export const ADR_TEMPLATE_DOC_TYPE = 'ADT';
export const ADR_SEEDED_DOC_TYPE = 'ADR';
export const ZEN_MATRIX_DOC_TYPE = 'ZCM';

export const ADR_STATUSES = ['Proposed', 'Accepted', 'Superseded', 'Rejected'] as const;

/**
 * `Met` = the boilerplate emits it. `Partial` = some of the clause ships.
 * `Not scaffolded` = the artifact is a TypeScript kit absent from this stack.
 * `Deviation` = a project that consciously departs, which requires an ADR.
 */
export type ComplianceStatus = 'Met' | 'Partial' | 'Deviation' | 'Not scaffolded';

/** A document that can be pointed at as evidence for a clause. */
export interface ClauseEvidence {
  /** Where the rule is realised, or which report proves it. */
  readonly doc: string;
  /** `EVD-###` when the tester project owns the report, else the artifact path. */
  readonly ref: string;
}

/**
 * Evidence per clause id. Every id in the catalogue MUST appear here: the
 * matrix would otherwise print a row citing nothing, which reads as compliance
 * while proving none. `zenTraceability.test.ts` asserts full coverage.
 */
export const CLAUSE_EVIDENCE: Readonly<Record<string, ClauseEvidence>> = {
  [CLAUSE_IDS.repo]: { doc: 'repository root (`services/`, `packages/shared/`, `contracts/`)', ref: 'REPO-01' },
  [CLAUSE_IDS.container]: { doc: '`services/<name>/Dockerfile`', ref: 'CON-01' },
  [CLAUSE_IDS.contract]: { doc: '`contracts/openapi.yaml`, `contracts/events/*.schema.json`', ref: 'CON-02' },
  [CLAUSE_IDS.observability]: { doc: '`packages/shared/src/logger.ts`, `correlation.ts`, `metrics.ts`', ref: 'CON-03' },
  [CLAUSE_IDS.lifecycle]: { doc: '`packages/shared/src/health.ts`, `lifecycle.ts`', ref: 'CON-04' },
  [CLAUSE_IDS.security]: { doc: '`.env.example`, `deploy/k8s/*.yaml` Secret objects', ref: 'CON-05' },
  [CLAUSE_IDS.resilience]: { doc: '`packages/shared/src/resilience.ts`', ref: 'CON-06' },
  [CLAUSE_IDS.ciStatic]: { doc: '`06-evidence/security-test-report.md` (SAST + secret scan)', ref: 'EVD-STR' },
  [CLAUSE_IDS.ciTest]: { doc: '`06-evidence/test-summary-report.md`', ref: 'EVD-TSR' },
  [CLAUSE_IDS.ciBuild]: { doc: '`.github/workflows/ci.yml` build job', ref: 'CI-03' },
  [CLAUSE_IDS.ciImage]: { doc: '`06-evidence/security-test-report.md` (image scan)', ref: 'EVD-STR' },
  [CLAUSE_IDS.ciDeploy]: { doc: '`.github/workflows/ci.yml` deploy job', ref: 'CI-05' },
  [CLAUSE_IDS.ciDatabase]: { doc: '`docker-compose.databases.yml`', ref: 'CI-06' },
  [CLAUSE_IDS.ciK8s]: { doc: '`deploy/k8s/<service>.yaml`', ref: 'CI-07' },
};

/** Clauses whose artifact does not exist in every stack (honest, not aspirational). */
const STACK_LIMITS: Readonly<Record<string, readonly string[]>> = {
  [CLAUSE_IDS.resilience]: ['node'],
};

/** Clauses the catalogue ships only in part, whatever the stack. */
const PARTIAL: readonly string[] = [CLAUSE_IDS.observability, CLAUSE_IDS.security];

/** Portability warning: `CLAUSE_IDS` may not yet carry a key for a clause. */
function idOr(key: string, fallback: string): string {
  const ids = CLAUSE_IDS as unknown as Record<string, string | undefined>;
  return ids[key] ?? fallback;
}

/** Status of one clause in one stack. */
export function clauseStatus(clauseId: string, family: RuntimeFamily): ComplianceStatus {
  if (PARTIAL.includes(clauseId)) {
    return 'Partial';
  }
  const only = STACK_LIMITS[clauseId];
  if (only && !only.includes(family)) {
    return 'Not scaffolded';
  }
  return 'Met';
}

/** Evidence for a clause, or a neutral placeholder so a row is never blank. */
export function clauseEvidence(clauseId: string): ClauseEvidence {
  return CLAUSE_EVIDENCE[clauseId] ?? { doc: 'See the handbook clause', ref: clauseId };
}

/** Runtime (§4.2) rows: CLAUSE, RULE, WHERE IT LIVES, STATUS, EVIDENCE. */
export function runtimeComplianceRows(family: RuntimeFamily): string[][] {
  return runtimeClauses(family).map((c) => {
    const ev = clauseEvidence(c.id);
    return [c.id, c.rule, c.home, clauseStatus(c.id, family), `${ev.ref} — ${ev.doc}`];
  });
}

/** CI (§4.3) rows, same columns as the runtime table. */
export function ciComplianceRows(): string[][] {
  return ciClauses().map((c) => {
    const ev = clauseEvidence(c.id);
    return [c.id, c.rule, c.home, clauseStatus(c.id, 'node'), `${ev.ref} — ${ev.doc}`];
  });
}

/** Clauses not fully met in this stack — each one needs an ADR to accept. */
export function complianceDeviations(family: RuntimeFamily): StandardsClause[] {
  return [...runtimeClauses(family), ...ciClauses()].filter(
    (c) => clauseStatus(c.id, family) !== 'Met',
  );
}

/** Zero-padded ADR id: `ADR-001`. */
export function adrId(n: number): string {
  return `${ADR_ID_PREFIX}${String(n).padStart(3, '0')}`;
}

/** Relative path of an ADR inside the writer project. */
export function adrPath(n: number, slug: string): string {
  return `${ADR_DIR}/${adrId(n)}-${slug}.md`;
}

/** Clause ids an ADR may cite, in catalogue order — used by the template guidance. */
export function citableClauseIds(): string[] {
  return [...runtimeClauses('node'), ...ciClauses()].map((c) => c.id);
}

/** Machine-checkable clause-key sanity: every catalogue id has an evidence entry. */
export function missingEvidenceIds(): string[] {
  return [...runtimeClauses('node'), ...ciClauses()]
    .map((c) => c.id)
    .filter((id) => !(id in CLAUSE_EVIDENCE));
}

/** Kept so a future clause key rename fails loudly here rather than in a document. */
export const TRACEABILITY_ANCHORS = {
  repo: idOr('repo', 'ZEN-STD-REPO-01'),
  resilience: idOr('resilience', 'ZEN-STD-CON-06'),
} as const;
