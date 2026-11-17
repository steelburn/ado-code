# ZEN Engineering Handbook — Alignment Review

> **Status: REVIEW COMPLETE — ALIGNMENT PHASES P1–P7, P1 SHIPPED (CON‑01 MET).** This is the review of the external
> standard *ZEN Computer Systems Internal Engineering Handbook: Microservices Architecture &
> Governance, v1.0* against ADO Code's scaffolding templates and boilerplates. The outcome is a
> decision record (§3) plus a phase plan (§8) that closes the gaps **in the boilerplates**, not in
> the handbook — with one deliberate exception: the handbook's per-service repository shape is
> superseded by the monorepo default, so §4.1 of the handbook is amended (§7). Scaffolding
> architecture lives in [project-scaffolding.md](project-scaffolding.md); this file is the
> external-standard input to it.

## 1. What was reviewed

| | |
|---|---|
| Artifact | `ZEN Computer Systems - Internal Engineering Handbook_ Microservices Architecture & Governance.docx` |
| Location | `D:\Development\vscode\Application Engineering Improvement\` (outside this workspace) |
| Size | 2.86 MB; ~37.4k chars of text; 283 blocks, 37 headings, 6 tables, 0 images |
| Metadata | `docProps/core.xml`: revision 29, created/modified 2026‑11‑16; `dc:creator`, `dc:title`, `dc:subject`, `dc:keywords` all empty |
| Structure | §1 Executive Architectural Directive · §2 Architectural Review & Readiness Checklist (2.1–2.5) · §3 Engineering Implementation Guide & FAQ (Q1–Q3.6) · §4 Standard Repository & Boilerplate Specification (4.1 layout, 4.2 six runtime standards, 4.3 five CI gates, 4.4 Prompt A/B) · prose "Document Control" block |
| Baseline commit | ADO Code `main` @ `814f011`, 16 catalogue templates (`project-scaffolding.md` §2.2), 2571 passing tests |

The handbook is normative from §4 onwards: §4.1–§4.3 are the clauses a scaffolded repository is
expected to satisfy. §1–§3 are policy and rationale and are treated as context.

## 2. Baseline compared against

| ADO Code artifact | Role in the comparison |
|---|---|
| `src/shared/monorepoStacks.ts` | per-stack monorepo writers: `Dockerfile`, `docker-compose.yml`, `ARCHITECTURE.md`, `packages/shared` |
| `src/webview/ProjectCreationService.ts` | `scaffoldMonorepoMicroservices`, `deploy/k8s/*.yaml` (`:3125`), `.github/workflows/ci.yml` (`:2804`) |
| `src/shared/containerization.ts` | single-project container planner (template → target map) |
| `src/shared/architectureStyles.ts`, `scaffoldContext.ts` | `layered | modular-monolith | microservices` (default `layered`), container resolution |
| `src/shared/serviceScaffold.ts` | `/new-service` — append-only service augmentation |
| `src/shared/documentation/docTemplates.ts` | `doc-ba` (12), `doc-writer` (19), `doc-tester` (16) document sets |
| `src/shared/testAutomationSuite.ts` | `testAutomation` option group, `ci: 'azure'` → `azure-pipelines.yml` |

## 3. Decision record

**D1 — The boilerplates move up to the standard.** Where the handbook is stricter than the emitted
baseline, the baseline changes. No clause is adopted as documentation-only; each gap in §4/§5
below names the file that closes it. The handbook is *not* softened to match what the wizard emits
today.

**D2 — Monorepo is the default topology; the handbook's §4.1 is amended.** The handbook prescribes
one repository per service (`/src`, `/tests`, `/contracts`, `/deploy`, `ci-pipeline.yaml` inside the
service root). ADO Code scaffolds one repository per bounded-context group: `services/<name>/`,
`packages/shared`, one repo-level pipeline with a service matrix, and `/new-service` to add a
service afterwards. Both describe the same engineering standard; the monorepo one is what the
toolchain guarantees (deterministic writers, golden fixtures, append-only augmentation). The
resolution is a handbook amendment (§7), not a topology change in code: `contracts/` moves to the
repository root, the CI file is one matrix pipeline, and the hexagonal internal split stays where
it is — inside each service. `contracts` is already a reserved service name (`project-scaffolding.md`
§13.2), so the root directory fits the existing name space.

**D3 — Handbook rules become executable artifacts.** A standard that only a human reads cannot
gate anything. §4.2/§4.3 must land in three enforcement points, in this order: the emitted files
(P1–P5), a named wizard preset that produces them (P6), and the managed `AGENTS.md` block so every
agent turn is held to the same rules (P6). §4.4's free-text "Prompt A / Prompt B" is retired to a
fallback for stacks the catalogue does not cover (Go today).

**D4 — Clause identity is a prerequisite.** Gates, evidence reports and change requests can only
cite the handbook line they satisfy if the clauses have ids. `ZEN-STD-<AREA>-<NN>` is used
throughout this document for that reason (§7, A4).

## 4. Clause verdicts — §4.1 topology

| Handbook | ADO Code baseline | Verdict |
|---|---|---|
| `/src` `/tests` `/contracts` `/deploy` `/ci-pipeline.yaml` per service repo | `services/<name>/src` + per-service `Dockerfile`; `packages/shared/src`; `deploy/k8s/`; `.github/workflows/ci.yml` matrix; `ARCHITECTURE.md` at root | **Amended (D2)** — handbook §4.1 rewritten, no code change |

Single-project templates (`node-ts`, `dotnet-webapi`, `python-fastapi`, `php-laravel`) are flat
(`package.json` + `tsconfig.json` + `src/index.ts` + `.gitignore` + `Dockerfile`) and stay flat:
the handbook's layout clause applies to microservice repositories, which is what
`architecture: 'microservices'` produces.

## 5. Clause verdicts — §4.2 runtime standards and §4.3 CI gates

Verified statements only; `USER`/`HEALTHCHECK`/`/metrics`/`SIGTERM`/`correlation-id`/`Idempotency`
had **zero** occurrences in `src/shared/**` at `814f011`; P1 has since added `USER`, `HEALTHCHECK` and the base-image pins — `/metrics`, the SIGTERM drain, correlation ids and `Idempotency-Key` stay absent until P3/P4.

### 5.1 §4.2 — six mandatory runtime standards

| # | Clause | Baseline today | Verdict | Phase |
|---|---|---|---|---|
| CON‑01 | Multi-stage, non-root, `HEALTHCHECK`, deterministic tag pin | **Became met in P1.** `src/shared/containerHardening.ts` is the single source: `BASE_IMAGES` (full `major.minor.patch` tags — no `:latest`, no minor-only pins) and `hardeningLines()` (non-root `USER` plus a port probe, behind an exhaustive `never`-checked switch). Every emitted `Dockerfile` — the 4 monorepo stacks, all containerized single-project templates, and the static targets (now `nginx-unprivileged` on 8080) — has ≥2 stages, a non-root user and a `HEALTHCHECK`; the .NET *console* variant is the documented exception (no endpoint to probe). The probe targets `/health` until P3 renames it to `/healthz/live` | **met** | P1 ✅ |
| CON‑02 | `openapi.yaml` (3.1), protobuf, versioned event envelope in `/contracts` | `packages/shared` ships type-level contracts (`dto`, `events`, `health`, `broker` interface) and a .NET `CommandEnvelope<T>(..., CorrelationId, ...)`; no `openapi.yaml`, no JSON Schema, no `/api/v1` prefix | **partial** | P2 |
| CON‑03 | JSON logs to stdout, `/metrics`, OTel + `X-Correlation-ID` | services log `console.log('[<service>] …')`; no metrics endpoint, no tracing, no correlation propagation | **unmet** | P3 |
| CON‑04 | `/healthz/live`, `/healthz/ready`, graceful SIGTERM | shared `health.ts` serves `/health` + `/ready` with `{status, service, version}`; k8s manifests do declare `livenessProbe: /health` and `readinessProbe: /ready` (`ProjectCreationService.ts:3125+`); no drain handler | **partial** | P3 |
| CON‑05 | JWT validation at the edge, secrets from env/Vault, crypto agility | `.env.example` only, zero hardcoded secrets; no auth path in the gateway | **partial — 1 of 3** | P3 |
| CON‑06 | 2–3 s timeouts, backoff with jitter, circuit breakers, `Idempotency-Key` | `ARCHITECTURE.md` states the rule in prose; no helper, no breaker, no idempotency guard | **unmet — policy only** | P4 |

### 5.2 §4.3 — five mandatory CI gates

| # | Gate | Baseline (`ProjectCreationService.ts:2755-2810`, golden fixture) | Verdict | Phase |
|---|---|---|---|---|
| CI‑01 | lint / SAST / secret scan | absent (no eslint step, no CodeQL/Semgrep, no gitleaks) | **unmet** | P5 |
| CI‑02 | unit + contract tests + coverage threshold | absent (the generated `ci.yml` runs `npm ci` then build) | **unmet** | P5 |
| CI‑03 | build | present: matrix install → build → `docker build` | **met** | — |
| CI‑04 | image scan | absent | **unmet** | P5 |
| CI‑05 | deploy | absent (no environment/deploy job); `azure-pipelines.yml` exists only when `testAutomation.ci: 'azure'` | **partial** | P5 |
| CI‑06 | one database per service | `docker-compose.yml` emits services + broker only (no DB container, no per-service schema/migrations dir) | **unmet** | P5 |
| CI‑07 | k8s hardening | `replicas`, probes, labels present; `image: <app>/<svc>:latest`, no `resources`, no `securityContext`, no `ConfigMap`/`Secret` | **partial** | P5 |

**Score at `814f011`:** of the 6 CON clauses, 0 fully met, 4 partial, 2 unmet — CON‑01 has since moved to **met** in P1, so the current count is 1 met, 3 partial, 2 unmet; of the 7 CI clauses,
1 met, 2 partial, 4 unmet. As published policy the handbook is coherent; as a standard the
baseline can satisfy today it is roughly 40 % realisable.

### 5.3 §4.4 — scaffolding mechanism

Prompt A ("generate the boilerplate for a new production-ready microservice") is exactly the
failure mode `/new-service` was built to remove — `src/shared/serviceScaffold.ts` documents that
free-form generation "fell back to hand-writing files from memory". Prompt A also names Go/Gin
first, which has no catalogue template. Verdict: **superseded by D3**, kept as documented fallback.

## 6. Corrections to the first-pass review

Recorded so the earlier reading is not relied on:

1. **Kubernetes probes exist.** The first pass reported "no probes"; the manifests at
   `ProjectCreationService.ts:3125+` do declare `livenessProbe` and `readinessProbe`. The gap is the
   probe *paths* (`/health`, `/ready` vs `CON‑04`) and the missing `resources`/`securityContext`.
2. **`/contracts` is not absent by accident.** `contracts` is a reserved service name in
   `/new-service` (`project-scaffolding.md` §13.2); the directory is simply unwritten. P2 writes it.
3. **.NET is not a weak point.** `monorepoStacks.ts:450` is a correct multi-stage publish; the
   container gap is PHP/Python plus the non-root/`HEALTHCHECK`/digest clauses across all four stacks.

## 7. Handbook amendments (ready to paste)

### A1 — §4.1 replacement (monorepo default)

> **4.1 Standard Repository Layout (one repository per bounded-context group)**
>
> A repository holds a group of related services — typically one product or platform area — not a
> single service. One repository per *service* is only justified when the service has its own
> owning team, an independent release cadence, and the repository would otherwise exceed roughly
> ten services; in that case `contracts/` moves to a shared contracts repository consumed as a
> versioned artifact.
>
> ```text
> repo-root/
> ├── services/<service-name>/        # one deployable unit
> │   ├── src/                        # domain / application / infrastructure / api
> │   ├── tests/                      # unit + integration for this service
> │   ├── Dockerfile                  # CON-01
> │   └── service.yaml                # owner, tier, SLOs
> ├── packages/                       # internal libraries: shared kernel, config, contract clients
> ├── contracts/                      # CON-02 — OpenAPI 3.1, event JSON Schemas, versioned
> ├── deploy/                         # docker-compose.yml, k8s manifests, env templates
> ├── tests/                          # cross-service: contract and end-to-end suites
> ├── .github/workflows/ci.yml        # ONE pipeline, matrix over services (CI-01…CI-05)
> └── ARCHITECTURE.md                 # bounded contexts, service map, rationale
> ```
>
> A new service is added by extending the repository (§4.4), never by copying an existing service
> directory, and never by generating files freehand.

### A2 — §4.2 wording that must match the emitted baseline

Keep the clauses as written (`/healthz/live`, `/healthz/ready`, `X-Correlation-ID`, JSON logs,
`/metrics`, timeouts/backoff with jitter/breaker/`Idempotency-Key`) — P1–P4 change the boilerplates
to meet them. Two clarifications to add:

> CON-01: "deterministic tag pin" means a digest or at minimum a full `major.minor.patch` tag; a
> minor-floating tag (`node:20-alpine`) does not satisfy this clause.
>
> CON-04: health endpoints are `/healthz/live` and `/healthz/ready`; deployment manifests must probe
> those paths, and the process must handle `SIGTERM` by failing readiness and draining.

### A3 — §4.4 replacement (preset, prompts as fallback)

> **4.4 Scaffolding.** New repositories are created from the toolchain's microservices preset, which
> emits the complete CON/CI-compliant baseline in one deterministic step:
> `architecture: microservices` · stack ∈ {Node+TS, .NET, Python, PHP/Laravel} · gateway service ·
> shared package · broker ∈ {NATS, Kafka, RabbitMQ} · containerization on · Kubernetes manifests on ·
> test automation on with the organisation's CI provider. Stacks outside the preset (Go today) are
> generated from the wizard's nearest template and then brought up to the standard by hand; the
> free-text prompts previously published here are that fallback only, never the default.

### A4 — Clause ids

Give every clause an id (`ZEN-STD-CON-01…06`, `ZEN-STD-CI-01…07`, `ZEN-STD-REPO-01…`) and document
the id in the emitted `ARCHITECTURE.md`. Ids are what make P5's gates and the `doc-tester` evidence
reports (`06-evidence/security-test-report.md`, `06-evidence/performance-test-report.md`) citeable.

## 8. Alignment phases

Each phase is independently shippable and lands with tests plus regenerated golden fixtures. Phase
order matters: P1–P5 change emitted files, P6 makes the preset emit them, P7 makes the standard
traceable.

| Phase | Change | Touch points | Acceptance |
|---|---|---|---|
| **P1 — container hardening ✅ shipped** | non-root `USER` + group, `HEALTHCHECK`, full-patch pins, multi-stage PHP and Python — landed as `containerHardening.ts` (`BASE_IMAGES` + `hardeningLines`) plus every writer in `containerization.ts`, `monorepoStacks.ts` and `ProjectCreationService.ts`; golden fixtures regenerated | `containerization.ts`, `monorepoStacks.ts:44,66,77,450,596`, single-project Dockerfile writers | **met**: `containerHardening.test.ts` walks every stack and containerizable template and asserts build stage, non-root user, `HEALTHCHECK`, pinned base image and a start command; `monorepoStacks.test.ts` asserts against `BASE_IMAGES`, so the pins cannot drift from the tests |
| **P2 — contract-first** | `contracts/openapi.yaml` per service (3.1, generated from the service list), `contracts/events/<topic>.schema.json`, `/api/v1` route prefix, `ARCHITECTURE.md` links the contracts | `monorepoStacks.ts`, `ProjectCreationService.ts` monorepo writer, `serviceScaffold.ts` (P2 must also stamp contracts for `/new-service`) | contracts dir exists in the monorepo tree; YAML/JSON parsed in a test; `/new-service` adds a contract file for the new service |
| **P3 — observability & lifecycle** | `packages/shared/src/logger.ts` (JSON lines + correlation id), `correlation.ts` middleware, `/metrics` (Prometheus text, dependency-free), `/healthz/live` + `/healthz/ready`, SIGTERM drain, JWT-verify hook in the gateway | shared package writers, service entrypoints, k8s probe paths, `ProjectCreationService.ts:3125` | new services emit JSON logs with the inbound `X-Correlation-ID`, serve `/metrics`, expose the new health paths, and drain on SIGTERM; k8s probes point at the new paths |
| **P4 — resilience kit** | `packages/shared/src/resilience.ts`: `withTimeout`, `retry` with jitter, `CircuitBreaker`, idempotency guard | shared package writers + `ARCHITECTURE.md` rule table | each `ARCHITECTURE.md` rule maps to an exported symbol; unit tests cover timeout, jitter bounds, breaker open/half-open, duplicate `Idempotency-Key` |
| **P5 — CI/CD gates + data** | `ci.yml`: lint/typecheck, unit + contract tests with coverage threshold, gitleaks, SAST, `docker build` + Trivy; deploy job environment; `azure-pipelines.yml` parity; compose DB service per service with a schema/migrations dir; k8s `resources`, `securityContext`, `ConfigMap`/`Secret`, digest image | `ProjectCreationService.ts:2755-2810` (ci.yml), `:3125` (k8s), `monorepoStacks.ts` compose, `testAutomationSuite.ts` | generated repo passes all five gates locally (`act`-free static test asserts the steps); compose brings up service + DB + broker; k8s manifest validates `kubectl --dry-run=client` shape in tests; image tag is not `latest` |
| **P6 — preset + AGENTS.md** | named `zen-microservices` preset resolving the D3 option set; managed `AGENTS.md` block in scaffolded repos carrying the CON/CI rules | wizard preset table, `src/webview/agentsMd.ts` managed block, catalogue test | choosing the preset yields every P1–P5 artifact with zero manual steps; the scaffolded `AGENTS.md` names the clause ids; catalogue test fails if a new template forgets the block |
| **P7 — traceability docs** | `ADR-###` document type in `doc-writer` (`01-design/adr/`), clause-id column in the RTM, KRiSA matrix entry | `docTemplates.ts`, register columns | `doc-writer` emits an ADR template traceable to `CR-###` and citable back to `ZEN-STD-*` |

## 9. Verification

- `npm run compile` + `node scripts/test.js` (2571 tests at baseline); every phase regenerates the
  golden fixtures under `src/test/suite/services/fixtures/` and adds clause-level assertions.
- `npm run check:version` is unrelated (release identity) and must stay green through the work.
- **CI is not a gate here** — the pre-commit Electron run is the evidence, as for every other change
  in this repo.
- Docs budget: this file is the only new document; the phase list above is registered in
  [project-scaffolding.md](project-scaffolding.md) §14.

## 10. The handbook as a document

Independent of the technical clauses, the `.docx` does not meet ADO Code's own documentation
contract (`doc-ba` / `doc-writer` / `doc-tester`): no YAML front matter (`docId`, `version`,
`owner`, `approver`), no revision-history table (`docProps` revision 29 is the only trace), no
document register or `document-plan.md`, no glossary despite ~37k chars of normative vocabulary, no
numbered requirement ids for an RTM, no approval/sign-off or classification, and no Markdown source
behind the binary. Inconsistent heading levels (`Title` used for the control block while "Section 1"
and "1.1" are both `Heading1`) and a missing TOC field compound it.

Recommended, in this order: convert to Markdown as source of truth → add front matter, revision
history and `ZEN-STD-*` clause ids (A4) → split by audience (`doc-ba` readiness checklist,
`doc-writer` design/ADR/runbook, `doc-tester` security + performance evidence for the §4.3 gates) →
publish through the Documentation Export path so `docDigest` and the `.csv` registers see it.

## 11. Out of scope

- Go/Gin coverage: no catalogue template; the handbook's Prompt A stays a documented fallback (A3).
- The `.docx` itself: written edits are supplied as amendment text (§7) because the artifact lives
  outside this workspace and is binary.
- `docs/test-automation.md` (the QA plan) is unaffected; P5 only makes the generated pipeline match
  what that plan already describes.
