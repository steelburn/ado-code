# ZEN Engineering Handbook — Alignment Review

> **Status: REVIEW COMPLETE — ALIGNMENT PHASES P1–P8 SHIPPED. FIVE OF SIX RUNTIME CLAUSES MET
> (CON‑01, CON‑02, CON‑04, CON‑05, CON‑06 — the last for the node stack only); CON‑03 PARTIAL —
> NO TRACER; ALL SEVEN §4.3 CI GATES MET; CLAUSE IDS CITABLE FROM `ADR-###` RECORDS AND A
> `ZEN-STD-*` COMPLIANCE MATRIX.**
> P6 makes the standard the *default*: a named `zen-microservices` preset and a standards `AGENTS.md`
> in every scaffold. This is the review of the external
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
had **zero** occurrences in `src/shared/**` at `814f011`; P1 has since added `USER`, `HEALTHCHECK` and the base-image pins — `/metrics`, the SIGTERM drain and correlation ids arrived in P3, and the resilience kit (timeouts,
jittered backoff, breaker, `Idempotency-Key`) in P4 — every one of them is now emitted.

### 5.1 §4.2 — six mandatory runtime standards

| # | Clause | Baseline today | Verdict | Phase |
|---|---|---|---|---|
| CON‑01 | Multi-stage, non-root, `HEALTHCHECK`, deterministic tag pin | **Became met in P1.** `src/shared/containerHardening.ts` is the single source: `BASE_IMAGES` (full `major.minor.patch` tags — no `:latest`, no minor-only pins) and `hardeningLines()` (non-root `USER` plus a port probe, behind an exhaustive `never`-checked switch). Every emitted `Dockerfile` — the 4 monorepo stacks, all containerized single-project templates, and the static targets (now `nginx-unprivileged` on 8080) — has ≥2 stages, a non-root user and a `HEALTHCHECK`; the .NET *console* variant is the documented exception (no endpoint to probe). The probe targets `/health` until P3 renames it to `/healthz/live` | **met** | P1 ✅ |
| CON‑02 | `openapi.yaml` (3.1), protobuf, versioned event envelope in `/contracts` | **Became met in P2.** At `814f011` `packages/shared` shipped type-level contracts only (`dto`, `events`, `health`, `broker` interface) plus a .NET `CommandEnvelope<T>(..., CorrelationId, ...)` — machine-readable by no tool outside the language. `src/shared/contractArtifacts.ts` now plans the contract set as data and emits it as text: `contracts/openapi/<service>.v1.yaml` (OpenAPI 3.1.0 over `/api/v1/<resource>`, `$ref`-resolved in a test), `contracts/events/envelope.v1.json` (JSON Schema 2020‑12 — `eventId`, `eventType`, `timestamp`, `source`, `payload` required; `correlationId`, `version` optional) and one self-contained schema per event whose `eventType` is pinned with `const`. Written by the node monorepo writer, by all three tree planners and by `/new-service`, never overwriting a contract that already exists. **Protobuf is absent by catalogue, not by omission** — no gRPC stack is offered, so HTTP/JSON is the entire surface; the clause counts as met with that exception stated | **met** | P2 ✅ |
| CON‑03 | JSON logs to stdout, `/metrics`, OTel + `X-Correlation-ID` | **Partly met in P3.** `packages/shared/src/{logger,metrics,correlation}.ts` give JSON-per-line logs on stdout, a Prometheus endpoint and an `X-Correlation-ID` reused at every hop (bounded, echoed, forwarded — never re-minted mid-trace). No OpenTelemetry SDK is emitted, so the clause stays partial | **partial — 3 of 4** (tracing absent) | P3 ✅ |
| CON‑04 | `/healthz/live`, `/healthz/ready`, graceful SIGTERM | **Became met in P3.** Every stack serves `/healthz/live` and `/healthz/ready` as separate handlers: Node through `installGracefulShutdown()` (withdraw readiness → drain in-flight → force-exit on timeout), .NET through `Lifetime.ApplicationStopping` (the host SIGTERM hook), Python and PHP through an `APP_DRAINING` marker. Readiness answers 503 while liveness keeps answering; the legacy `/health` stays served because the `HEALTHCHECK` probes it | **met** | P3 ✅ |
| CON‑05 | JWT validation at the edge, secrets from env/Vault, crypto agility | **Became met in P8.** The node stack gets `packages/shared/src/auth.ts` — RS/PS/ES/HS with a `kid` keyring, an algorithm allowlist checked *before* the signature so an HS256 token signed with the service's public key never reaches the RSA keyring, `exp`/`nbf`/`iat`/`iss`/`aud`/`sub` with a 30 s skew, JWKS refresh on an unknown `kid`, previous HMAC secret valid during a rollover — and `secrets.ts` (`requireSecret` with no fallback, a placeholder rejected, boot fails listing every missing name). The gateway validates and stamps; every service verifies the stamp and **fails closed**, because an unset `EDGE_AUTH_REQUIRED` means required. Python, .NET and PHP carry no shared package, so `securityEdgeGuards.ts` emits `app/security.py`, `Security/EdgeAuthMiddleware.cs` and `app/Http/Middleware/VerifyEdgeIdentity.php`: the same HMAC-SHA256 over the same canonical `subject\|scopes\|issuer\|issuedAt`, constant-time comparison, same 300 s window, registered in each entrypoint with the platform probes exempt. `.env.example` holds an empty `EDGE_AUTH_SHARED_SECRET`, compose interpolates it with `:?` so a stack without the secret aborts, and the k8s Secret keeps `stringData: {}`. No credential is committed anywhere. | **Met** (all four stacks) | P8 ✅ |
| CON‑06 | 2–3 s timeouts, backoff with jitter, circuit breakers, `Idempotency-Key` | **Became met in P4 for the node stack.** `src/shared/resilienceArtifacts.ts` emits `packages/shared/src/resilience.ts`: `withTimeout` (aborts the signal it hands you), `retry`/`backoffDelay` (full jitter, 2500 ms, 3 attempts, retrying only 5xx/network/timeout), `CircuitBreaker` (`closed` → `open` → `half-open`, per dependency) and `IdempotencyGuard` (replay, fingerprint conflict → `IdempotencyConflictError`, concurrent duplicate awaits the in-flight call). The gateway enforces `Idempotency-Key` on writes, wraps each upstream call in `withTimeout` and trips a breaker per route; the `ARCHITECTURE.md` rules are generated from `RESILIENCE_RULES`. **Residual:** `python`/`dotnet`/`php-laravel` trees carry no `packages/shared`, so for those stacks the rule is still documentation — queued as P4b. | **met (node stack) — residual on 3 stacks** | P4b |

### 5.2 §4.3 — five mandatory CI gates

| # | Gate | Baseline (`ProjectCreationService.ts:2755-2810`, golden fixture) | Verdict | Phase |
|---|---|---|---|---|
| CI‑01 | lint / typecheck + SAST + secret scan | **met** — `gate-static` (family lint + typecheck) and `gate-security` (gitleaks `v8.21.2` secret scan, Semgrep `1.90.0` `p/default` SAST, both pinned) | **met** | P5 ✔ |
| CI‑02 | unit + contract tests + coverage threshold | **met** (guard fixed in P7 — it hashed a filename the planner never writes, so the step skipped silently until then) — `gate-test` runs the stack test command, Redocly lint of `contracts/openapi/*.v1.yaml`, `scripts/validate-event-schemas.mjs`, and `c8 --check-coverage --lines 80` (test step *and* coverage guarded by `hashFiles`: an empty suite skips instead of failing on pytest exit 5, and cannot silently pass once a test exists) | **met** | P5 ✔ |
| CI‑03 | build | **met** — `gate-image` builds every service image in a matrix, resolving the folder (`services/Users` vs `services/users`) instead of assuming it | **met** | P5 ✔ |
| CI‑04 | image scan | **met** — Trivy `0.56.2` on the built image, `--severity HIGH,CRITICAL --ignore-unfixed --exit-code 1` | **met** | P5 ✔ |
| CI‑05 | deploy | **met** — `gate-deploy` needs all four earlier jobs, runs only on `main`, sits behind `environment: production` (manual approval) and applies `deploy/k8s` when k8s is on | **met** | P5 ✔ |
| CI‑06 | one database per service | **met** — `docker-compose.databases.yml` overlay: one pinned `postgres:16.4-alpine` per domain service, own role, own volume, own port (5433+index), `pg_isready` healthcheck, `DATABASE_URL` injected per service; the gateway is excluded | **met** | P5 ✔ |
| CI‑07 | k8s hardening | **met** — `ConfigMap` + `Secret` (`stringData: {}`, values created out of band), `resources` requests/limits, `runAsNonRoot` + per-family `runAsUser`, `readOnlyRootFilesystem`, `drop: ["ALL"]`, `/tmp` emptyDir, `preStop` drain, tag = project version (never `latest`) | **met** | P5 ✔ |

**Score at `814f011`:** of the 6 CON clauses, 0 fully met, 4 partial, 2 unmet; of the 7 CI clauses, 1 met, 2 partial,
4 unmet. **Current count: 4 met** (CON‑01 in P1, CON‑02 in P2, CON‑04 in P3, CON‑06 for the node
stack in P4), 1 partial (CON‑03 short only of its tracing half), 1 unmet (CON‑05, security). As
published policy the handbook is coherent; as a standard the baseline could satisfy
at `814f011` it was roughly 40 % realisable, and the four clauses closed so far hold for
every emitted project.

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
P1–P5 change emitted files, P6 makes them reachable and binding, P7 (shipped) makes the standard
citable, and P8 (shipped) closes the last runtime clause: application security.

| Phase | Change | Touch points | Acceptance |
|---|---|---|---|
| **P1 — container hardening ✅ shipped** | non-root `USER` + group, `HEALTHCHECK`, full-patch pins, multi-stage PHP and Python — landed as `containerHardening.ts` (`BASE_IMAGES` + `hardeningLines`) plus every writer in `containerization.ts`, `monorepoStacks.ts` and `ProjectCreationService.ts`; golden fixtures regenerated | `containerization.ts`, `monorepoStacks.ts:44,66,77,450,596`, single-project Dockerfile writers | **met**: `containerHardening.test.ts` walks every stack and containerizable template and asserts build stage, non-root user, `HEALTHCHECK`, pinned base image and a start command; `monorepoStacks.test.ts` asserts against `BASE_IMAGES`, so the pins cannot drift from the tests |
| **P2 — contract-first ✅ shipped** | `contracts/openapi/<service>.v1.yaml` per service (OpenAPI 3.1.0, generated from the service list), `contracts/events/envelope.v1.json` + `contracts/events/<event>.v1.json`, `/api/v1` route prefix in every stack, `ARCHITECTURE.md` links the contracts — landed as `src/shared/contractArtifacts.ts` (§14.2) | `contractArtifacts.ts` (new), `monorepoStacks.ts`, `ProjectCreationService.ts` monorepo writer, `serviceScaffold.ts` | 27 tests in `contractArtifacts.test.ts`; golden fixtures 11 contract files (defaults) / 8 (option-heavy); `/new-service` stamps the new service's contract and reports a collision instead of overwriting |
| **P3 — observability & lifecycle ✅ shipped** | `packages/shared/src/logger.ts` (JSON lines + correlation id), `correlation.ts` middleware, `/metrics` (Prometheus text, dependency-free), `/healthz/live` + `/healthz/ready`, SIGTERM drain, JWT-verify hook in the gateway | shared package writers, service entrypoints, k8s probe paths, `ProjectCreationService.ts:3125` | new services emit JSON logs with the inbound `X-Correlation-ID`, serve `/metrics`, expose the new health paths, and drain on SIGTERM; k8s probes point at the new paths |
| **P4 — resilience kit ✅ shipped (node stack)** | `packages/shared/src/resilience.ts`: `withTimeout` (aborts the signal it hands you), `retry`/`backoffDelay` (full jitter, 2500 ms, 3 attempts), `CircuitBreaker` (`closed`/`open`/`half-open` per dependency), `IdempotencyGuard` (replay, fingerprint conflict, concurrent duplicate awaits in-flight) | `resilienceArtifacts.ts`, shared-package writers, gateway, `ARCHITECTURE.md` rule table | 31 tests transpile and *run* the generated module: timeout fires and aborts, jitter stays in `[0, cap]` over 200 samples, all four breaker transitions, duplicate replays, conflicting key throws; every `ARCHITECTURE.md` rule names an exported symbol. **Non-node stacks pending as P4b.** |
| **P4b — resilience for the non-node stacks** | the same four primitives in Python, C# and PHP under the same symbol names, so `ARCHITECTURE.md` stays stack-neutral | `monorepoStacks.ts` | each stack's generated kit passes the same behavioural tests as the TypeScript one |
| **P5 — delivery gates + data ✅ shipped** | `deliveryArtifacts.ts` renders three artifacts from one source: `ci.yml` with five blocking gates (GATE‑01…05), `docker-compose.databases.yml` (one database per service), and `deploy/k8s/<service>.yaml` (ConfigMap + Secret + Deployment + Service with resources, securityContext and observability probes). Emitted for **all four** stacks via `planMonorepoTree` and for the node writer via the host | `deliveryArtifacts.ts`, `deliveryFiles.ts`, `ProjectCreationService.ts`, `monorepoStacks.ts` | 35 tests: five gates present/ordered/cited by id, deploy blocked by all four and only from `main`, pinned scanners, matrix patchable by `/new-service`, per-stack commands, overlay one-DB-per-service with no shared URL, manifests carry resources + non-root + real probe paths and never `:latest`, k8s opt-in per tree. Residual: `azure-pipelines.yml` parity and digest pins not emitted — see §14.5 |
| **P6 — preset + AGENTS.md ✅ shipped** | `src/shared/wizardPresets.ts` — one `zen-microservices` preset per catalogue stack (`node-ts` is the default id), `resolvePreset` validating rather than coercing, and a `satisfies` list that omits CON‑05 and, outside Node, CON‑06. `src/shared/standardsArtifacts.ts` — clause catalogue (`ZEN-STD-CON-01…06`, `ZEN-STD-CI-01…07`) plus the generated `AGENTS.md` with a `zen-standards`-delimited managed block, per-stack artifact paths and `appendStandardsService` for `/new-service`. Wizard: preset strip in `StepProjectType`, applied in `index.tsx` | `wizardPresets.ts` (new), `standardsArtifacts.ts` (new), `StepProjectType.tsx`, `index.tsx`, `styles.css`, `monorepoStacks.ts` (`standardsFiles` merged into every stack tree), `ProjectCreationService.ts` (node writer + `/new-service`) — §14.6 | **met**: 20 new tests. `wizardPresets.test.ts` checks every preset against `PROJECT_TEMPLATES` itself (template exists, option ids rendered, values accepted) and scaffolds the preset end-to-end, asserting contracts, all five shared modules, `ci.yml`, both compose files, the Dockerfile, `deploy/k8s/` and every `satisfies` id in the generated `AGENTS.md`. `standardsArtifacts.test.ts` covers clause coverage, marker integrity, per-stack paths, prose-preserving replacement and the service append. Golden fixtures 52 / 25 files. The `AGENTS.md` write was found to sit inside the `if (ci)` branch — the two fixtures disagreeing (52 vs 24) exposed it; now unconditional. Residual: no OTel/JWT artifact, so CON‑03 stays partial and CON‑05 unmet |
| **P7 — ADR document type + clause-id traceability ✅ shipped** | `src/shared/documentation/zenTraceability.ts` — matrix rows generated from the clause catalogue in `standardsArtifacts.ts` (`runtimeComplianceRows` / `ciComplianceRows`), `clauseStatus(id, family)` returning `Met` / `Partial` / `Not scaffolded` / `Deviation`, `complianceDeviations`, `adrId` / `adrPath` / `ADR_TEMPLATE_PATH`, and `missingEvidenceIds()` as the no-row-without-evidence guard. `doc-writer` gains four documents: the ADR log (with a generated deviations table), the blank template, a seeded Accepted `ADR-001-monorepo-as-default`, and `05-traceability/zen-standards-compliance.md` | `zenTraceability.ts` (new), `docTemplates.ts` (`adrDocs()`, 21 → 25 specs) — §14.7 | **met**: 20 new tests. Clause coverage and id shape, per-stack status (CON‑06 `Met` for node, `Not scaffolded` for python/dotnet/php), five non-empty columns per row, seven delivery gates, deviations exactly `{CON‑03, CON‑05}`, ADR id padding, the template path carrying no number, **doc-type uniqueness across the writer set** (collides on `<PROJECT>-<ROLE>-<TYPE>-001` otherwise), option gating, and the rendered matrix citing only catalogue ids plus every catalogue id. Residual: no RTM clause column — `RTM_COLUMNS` is the `REQ-ID` join contract shared with `doc-tester`, so clauses trace through the new matrix to `EVD-###` instead — and the KRiSA matrix entry stays opt-in |
| **P8 — application security ✅ shipped** | `securityArtifacts.ts` (node `auth.ts` + `secrets.ts`, edge stamp, algorithm allowlist before the keyring) and `securityEdgeGuards.ts` (python/.NET/PHP stdlib guards on the same canonical message) — wired into the gateway, every service entrypoint, .env.example, compose and the k8s Secret. | CON‑05 flips to met for all four stacks; 36 + 15 tests execute the generated module against real crypto. | CON‑05 met; only CON‑03 (no tracer) remains. |

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
