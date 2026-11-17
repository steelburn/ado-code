# Project Scaffolding — Architecture Options

> **Status: PHASES 1–8 IMPLEMENTED; 9–11 ARE OPEN.** The shared architecture/context modules,
> the golden fixtures, the monorepo decomposition, the `architecture` select on the five stack
> templates, `showWhen`, the `testAutomation` option group, the per-stack monorepo writers, the
> containerization layer and `/new-service` (§13) are in the tree and green, and phase 4 has no
> residual left — F2, the ignore-file label space, is retired too (§13.4). Section 3 records
> the findings behind the design and §11 records what the first phases actually changed; two
> claims that verification disproved are in §3, and §11 corrects a third (F3).
>
> **External standard:** alignment with the *ZEN Computer Systems Internal Engineering Handbook*
> (containers, contracts, observability, resilience, CI gates, monorepo topology) is reviewed in
> [zen-handbook-review.md](zen-handbook-review.md) — its phases P1–P7 are the outstanding work
> against that standard, separate from the phases 9–11 listed here.

## 1. Scope

| In | Out |
|---|---|
| Architecture as a selectable option on server-capable templates | Changing the `layered` (monolithic) output — must stay byte-identical |
| Cross-stack microservices (monorepo + `services/*` + compose) for Node, Python, Laravel, .NET | Providing microservices for frontend-only, mobile, console, library or doc templates |
| Modular monolith per stack | Optional docker for microservices (compose is required) |
| — (test automation split out to [test-automation.md](test-automation.md)) | Extending `doc-tester`’s document set; the doc renderer stays untouched |
| `/new-service` slash + palette command + `add_service` LLM tool that augments an existing microservices repo | Retrofitting non-microservices repos — `/new-service` refuses rather than guesses |

## 2. Current state (verified)

### 2.1 Pipeline

| # | Stage | Code | Keyed by |
|---|---|---|---|
| 1 | Webview collects `{targetPath, projectName, templateId, templateOptions, git…}` | `ProjectCreationWizard/*` + `PROJECT_TEMPLATES` defaults | templateId |
| 2 | Validation, dir resolution → `{warnings, postCreateSteps}` | `ProjectCreationService.ts:36-152` | — |
| 3 | Layout writing | `scaffoldByTemplate():155` → 16 cases (`:169-213`) | templateId |
| 4 | Cross-cutting writers | `writeGitignore():3056`, `writeLicense()` | *internal label* (see F2) |
| 5 | Toolchain/install plan | `planForTemplate()` in `src/shared/projectDependencies.ts` | templateId |
| 6 | git init + initial commit | `ProjectCreationService.ts:~3100` | — |

Only `templateId` flows to stages 3, 4 and 5, and stage 5 is the only one that even
receives `templateOptions`. Architecture cannot be expressed as an extra case: it must
become a value that reaches all three.

### 2.2 Catalogue ids (16 templates)

`node-ts`, `node-js`, `python`, `php-laravel`, `dotnet-webapi`, `dotnet-console`,
`dotnet-maui`, `react-ts`, `nextjs`, `react-native`, `flutter`,
`monorepo-microservices`, `empty`, `doc-ba`, `doc-writer`, `doc-tester`.

There are **no `fullstack-*` templates** — an earlier assumption in this plan was wrong.

### 2.3 Per-stack today

| Stack | Method | Layout | Containerization today | Notes |
|---|---|---|---|---|
| `node-ts` | `:243` | `src/index.ts` + `src/app.ts` | `docker` bool → one `Dockerfile` (`:332`), no compose | |
| `node-js` | `:343` | same | none | |
| `python` | `:387` | `src` layout | none | |
| `php-laravel` | `:428` | `composer.json` + framework tree | none | PSR-4 `App\` → `app/`, so `app/Modules/…` needs no composer change |
| `dotnet-webapi` | `:563`-ish | csproj + `Controllers/` | `Dockerfile` (`:~608`) | `.sln` GUID helper already exists |
| `monorepo-microservices` | `:2209-3013` | `services/*` + `packages/shared` | `Dockerfile` (`:2713`), compose (`:2846`), k8s, CI matrix | ~800 lines, **Node-only** |

## 3. Findings

- **F1 — Microservices is not a cross-stack capability (blocking).** `scaffoldMonorepoMicroservices`
  is hard-wired to Node (`workspaces`, `.npmrc`, turbo/nx, a TypeScript shared package).
  "Use the monorepo shape for microservices" is only true for TS/JS; .NET/PHP/Python have no
  service root, no compose, no per-service manifest. Fix by decomposing into
  `monorepoRoot()` / `serviceBody()` / `compose()`, not by cloning 800 lines three times.
- **F2 — `writeGitignore` has its own id space (corrected).** Keys include `php` and `dotnet`
  *in addition to* `php-laravel` and `dotnet-webapi`; each call site passes a literal
  (`:337`, `:381`, `:422`, `:526`, `:563`, `:613`, `:631`, `:2199`, `:3050`). It is therefore a
  **third, ad-hoc identifier space**, not a templateId lookup and not a fall-through bug.
  The `php` label is reachable only through the dead `case 'php'` (`:181`). Architecture-aware
  ignores are impossible with the current signature.
- **F3 — No `.dockerignore` exists anywhere.** Every containerized project would ship
  `node_modules`, `.venv`, `bin/obj` into build contexts. New writer required.
- **F4 — Docker is a choice, and inconsistently present.** `node-ts` and the monorepo template
  have a `docker` flag; Python/Laravel have none. Containerization must become *derived*:
  a `docker:false` request against microservices is ignored with a warning.
- **F5 — `planForTemplate` cannot see architecture.** It takes `options` but reads only
  `workspaceTool`/`expo`; there is no docker/compose check for any template, and an unknown id
  falls through to a git-only plan **silently**. A microservices project would report
  "nothing needed" for docker.
- **F6 — Catalogue entry `monorepo-microservices` is a stack pretending to be a project type.**
  It is the only template whose `category` encodes an architecture. Removing it is the point
  of this change; the dispatch case remains as a deprecated alias.
- **F7 — Dead `case 'php'` (`:181`) + `php` gitignore label.** Pre-existing; must not be
  mistaken for the Laravel microservices path.
- **F8 — Multi-manifest install has no story.** `installDependencies` runs once per project;
  `services/*` yields N manifests. Auto-install stays root/workspace-only, per-service
  install commands are emitted as `postCreateSteps`.
- **F9 — Tests only cover default options** (`projectCreation.test.ts:109` loops
  `PROJECT_TEMPLATES` with defaults), so every architecture branch would be invisible to the
  suite. The monorepo options test (`:524`) is the only precedent.

Disproved during verification, recorded so nobody re-chases them:
the `.gitignore` map is **not** failing to match `dotnet-webapi`/`php-laravel` (F2 above — it
never used template ids), and **no `fullstack-*` templates exist** to include in the allow-list.

## 4. Target design

### 4.1 One context instead of three more cases

```ts
// src/shared/architectureStyles.ts  (new; host + webview share it, like projectDependencies.ts)
export type ArchitectureStyle = 'layered' | 'modular-monolith' | 'microservices';
export const ARCHITECTURE_STYLES: { id: ArchitectureStyle; label: string; description: string }[];
export function architectureOption(defaultStyle?: ArchitectureStyle): TemplateOption;
export function supportsArchitecture(templateId: string): boolean;
export function resolveArchitecture(opts: Record<string, unknown>): ArchitectureStyle; // default 'layered'

// src/shared/scaffoldContext.ts  (new)
export interface ScaffoldContext {
  templateId: string;
  stack: 'node-ts' | 'node-js' | 'python' | 'php-laravel' | 'dotnet';
  architecture: ArchitectureStyle;
  containerization: { docker: 'required' | 'optional'; compose: boolean };
  testAutomation?: TestAutomationSpec;
  ci: 'none' | 'github' | 'azure';
}
```

`ScaffoldContext` is threaded through stage 3 dispatch → `writeGitignore(dir, ctx)` →
`.dockerignore` writer → `planForTemplate(ctx)`. That single API change fixes F2, F3 and F5.

**Allow-list** (`supportsArchitecture`): `node-ts`, `node-js`, `python`, `php-laravel`,
`dotnet-webapi`. Excluded: `react-ts`, `nextjs`, `react-native`, `flutter`, `dotnet-maui`,
`dotnet-console`, `empty`, `doc-*`. A frontend has one deployable; "modular monolith" there
means route groups, a different concept — out of scope deliberately.

**F2 was retired on the label side, not the context side (§13.4).** `writeGitignore` now takes a
`GitignoreLabel` — a typed union with an exhaustive `Record<GitignoreLabel, string>` body map in
`src/shared/gitignoreTemplates.ts` and no `|| 'node_modules/'` default — so the ignore writers
need no context at all: an exhaustive map is the stronger guarantee, because a label without a
body fails the build instead of reaching a callee that would have had to interpret the context.
The rest of this sketch (one context for the layout writers and the planner, F3/F5) stands.

### 4.2 Containerization rule

> **Compose is required as soon as the project has more than one runtime process.**

| Architecture | Docker | Compose | Rationale |
|---|---|---|---|
| `layered` | unchanged today (option where it already exists) | none | no behaviour change |
| `modular-monolith` | **default on**, opt-out allowed | off until the project declares a DB or broker, then forced on | one deployable *can* run bare |
| `microservices` | **required** | **required** | N services + broker + DB |

`resolveContainerization()` is the only authority; a conflicting `docker:false` is dropped with
a warning. Docker remains a **soft prerequisite** (warning + `docker compose config` validation
step), never a hard create failure — wizards run on machines that are not dev boxes.

### 4.3 Cross-stack microservices contract

Three reusable writers replace the 800-line Node-only generator:

```
monorepoRoot(stack, tooling, services)  workspace manifest, root scripts, root .gitignore
serviceBody(stack, svcName, kind)       one self-contained service, own manifest
compose(services, broker, db)           docker-compose.yml + .env.example + .dockerignore per service
```

| Stack | Root manifest | Service manifest | Workspace tool | Notes |
|---|---|---|---|---|
| `node-ts` / `node-js` | `package.json` + `tsconfig.base.json` | `services/<svc>/package.json` | npm / pnpm / yarn (`showWhen`-gated) | keeps turbo/nx + shared TS package |
| `dotnet-webapi` | `.sln` + `Directory.Build.props` | `<Svc>.csproj` | fixed | deterministic GUIDs (no churn between runs) |
| `php-laravel` | root `composer.json` with path repositories | per-service `composer.json` | fixed | PSR-4 per service |
| `python` | root `pyproject.toml` | `services/<svc>/pyproject.toml` | fixed | shared `contracts/` package |

Microservices always means monorepo + `services/*` for **every** stack — the user's constraint,
applied uniformly.

### 4.4 Architecture matrix

| Stack | `layered` (unchanged) | `modular-monolith` | `microservices` |
|---|---|---|---|
| node-ts / node-js | `src/index.ts`, `src/app.ts` | `src/modules/<m>/{domain,application,infrastructure,api}`, `src/shared/{kernel,contracts}`, module registry in `src/main.ts`, ESLint `no-restricted-imports` boundary rule | monorepo + `services/*` + compose, via `monorepoRoot`/`serviceBody`/`compose` |
| python | `src/<pkg>/…` | `<pkg>/modules/<m>/…`, registry in `main.py`, **import-linter** contract in `pyproject.toml` | root + per-service `pyproject.toml`, shared `contracts/` |
| php-laravel | `app/Http/Controllers`, `app/Models` | `app/Modules/<M>/{Domain,Application,Infrastructure,Http}`, `app/Shared/`, one `ServiceProvider` per module, **deptrac.yaml** | root composer path repos + per-service app |
| dotnet-webapi | `Controllers/`, `Models/`, `Program.cs` | single csproj: `Modules/<M>/{Domain,Application,Infrastructure,Api}` + `Shared/`, `IModule` + `AddModules()`; boundaries documented in `ARCHITECTURE.md` (no new NuGet) | `.sln` + one csproj per service |

Inputs are comma-separated with defaults so an empty answer still yields a valid tree:
`services` → `api,worker`, `modules` → `core`.

### 4.5 Conditional options (`showWhen`)

Once one template serves three architectures, its options must be architecture-scoped, and
`TemplateOption` currently has no conditional visibility — every `node-ts` user would see
`workspaceTool`, `broker`, `services`, `k8s` and CI-matrix controls regardless of choice.

```ts
export interface TemplateOption { …; showWhen?: (values: Record<string, unknown>) => boolean }
```

`StepTemplateOptions` filters on it before render. Also reused by the test-automation options
(`perf`, `reporting`).

### 4.6 Deprecation of `monorepo-microservices`

The catalogue entry, its `monorepo` category and `'Monorepo & Microservices'` label are
removed. `scaffoldByTemplate` keeps a **rewriting** alias for one release so existing
requests, `projectCreation.test.ts:524` and `.ado-code/e2e/run.js` keep passing:

```ts
case 'monorepo-microservices':
  return scaffoldByTemplate({ ...request, templateId: 'node-ts',
    templateOptions: { ...request.templateOptions, architecture: 'microservices' } });
```

The alias must rewrite the request rather than recurse, or `architecture` re-triggers it.
The removal gets its own CHANGELOG note.

## 5. Test automation

Split out to **[test-automation.md](test-automation.md)** — template, option group, generator,
dependency plan, tests, risks and its own decisions log (T1–T7).

Two things stay here because they are sequencing constraints on *this* work:

- It is an **independent track**: it does not depend on the architecture branches, and needs only
  two shared prerequisites — `TemplateOption.showWhen` (phase 5) and an options-aware
  `writeGitignore` (phase 4).
- The last open question is closed: test automation is its own template with a `qaDocs` opt-in,
  **default off**.

## 6. `/new-service`

Three entry points, one implementation: a slash command (`/new-service`), a palette command and
an **LLM tool** (`add_service`). All three add one service to an **existing** microservices
repo. It is the second consumer of `serviceBody`/`compose`, which is the concrete argument for
decomposing F1 before writing the wizard branches.

### 6.1 Target detection

Marker file at the **project root**: `.ado-project.json` (committed).

```json
{ "stack": "php-laravel", "architecture": "microservices",
  "workspaceTool": "npm", "broker": "rabbitmq", "db": "postgres", "serviceKind": "api" }
```

> Corrected decision: the marker was planned at `.ado-code/project.json`, but `.ado-code`
> **is gitignored** (`.gitignore:9`) and means *per-user, machine-local* state — it must not
> hold committed architecture metadata. Hence a root-level dotfile, never ignored by
> `writeGitignore`.

The service list is **not** stored: `docker-compose.yml` is authoritative, because a cached array
would drift the first time anyone edits compose by hand. Fallback when the marker is absent
(pre-existing repos, or a hand-written compose): sniff `docker-compose.yml` + `services/*`, and
take the stack from `*.sln` / `composer.json` / `pyproject.toml` / `package.json`.

### 6.2 Contract

`/new-service [name] [--kind api|worker] [--dry-run]`

| Step | Rule |
|---|---|
| Resolve target | workspace root; refuse with an actionable message if the repo is not microservices |
| Name | kebab-case, stack-legal identifier, reject reserved names (`shared`, `contracts`, `infra`) and names already in compose |
| Preview | print the file list and the compose/`services` block to be appended; confirm unless `--dry-run` |
| Write | **append-only**: `services/<name>/`, one compose service + network entry, `.env.example` keys, CI matrix entry, k8s overlay if present, root README table row, `docs/architecture.md` line |
| Never | re-init git, commit, auto-install, rewrite existing files wholesale, overwrite compose |
| Output | summary + `postCreateSteps` (`cd services/x && <install>`, `docker compose up <name>`) |

Idempotency is the hard requirement: a second run refuses at the name check and no existing
service entry is ever duplicated.

### 6.3 Decisions

1. **Exposed to the LLM as the `add_service` tool**, alongside slash + palette — see 6.5. Consent
   comes from the approval card and the mutating-tool gate, not from withholding the capability.
2. **`--kind api|worker` for all four stacks from day one**; worker bodies are ~15 lines each.

### 6.4 Plumbing

| File | Change |
|---|---|
| `src/shared/slashCommands.ts` | `new-service` entry (`requiresArgs: false`) |
| `src/webview-ui/src/components/InputBar.tsx:13` | mirror entry + a drift test (the mirror is a pre-existing hazard; this is the third command to need dual upkeep) |
| `ChatViewProvider.ts:6935` | `case 'new-service'` → prompt for a name, call the service, render the result |
| `ChatViewProvider.ts:6773` | add to the hard-coded `/help` list |
| `src/webview/ServiceScaffoldService.ts` *(new)* | vscode-free: `detectMicroservicesProject`, `listServices`, `addService`; consumes `serviceBody`/`compose` |
| `extension.ts` + `package.json` | `adoCode.newService` palette command, same handler |

### 6.5 LLM tool: `add_service`

The LLM may add a service. It is registered exactly like `build_documentation`
(`tools.ts:872` schema, `:1546` executor case) — the closest precedent, since that tool also runs
the wizard's own scaffolder and returns JSON.

**Registration points (all four are required):**

| # | File | Change |
|---|---|---|
| 1 | `src/llm/tools/types.ts` | `add_service` in the `ToolName` union, `ToolGroupMap.write`, `TOOL_GROUP_MAP`, `TOOL_DISPLAY_NAMES` |
| 2 | `src/llm/tools.ts:226` | `MUTATING_TOOLS` — the authoritative consent gate |
| 3 | `src/llm/tools.ts` `getTools()` | schema: `name` (required), `kind` (`api`/`worker`, default `api`), `dryRun` (default `false`) |
| 4 | `src/llm/tools.ts` `createToolExecutor()` | `case 'add_service'` → `ServiceScaffoldService.addService(...)`, `capToolResult`, JSON out, `{ error }` never throw |

The group map and the `ToolGroupMap` interface both spell the member lists literally, so a
half-registration is a **compile error** — that is the cheap guard. `MUTATING_TOOLS` is the costly
one: a tool missing from it is auto-executable, so **inline mode would mutate the repo with no
approval card**. Silent, not loud. A test asserts `write`-group ⊆ `MUTATING_TOOLS`.

**Mode behaviour** — falls out of the group, no `modes.ts` change: plan mode excludes `write`;
inline shows the approval card via `canAutoExecute`; act/yolo auto-run. No bespoke `confirm`
param: `write_to_file` has none, and a second consent mechanism would be inconsistent with the
tool system.

**Prompt budget** — tool schemas travel in the API `tools` array, not in
`generateSystemPrompt()`, so the 7,200-char static-prompt test is untouched and no second
injection point is added. Cost is the description only, paid per request ⇒ keep it ≤ 300 chars.

**Guards stay in the service, not the tool** — microservices-only refusal, kebab-case + reserved
names, collision with existing compose services, `../` escape. Slash, palette and LLM share one
refusal-first function, so an LLM cannot reach a path the CLI can't.

**The tool must not install or commit** — it returns `postCreateSteps` and the model reports
them. `dryRun` returns the file list and compose diff without writing.

**Tests** (in addition to the slash-command set in §8): plan mode blocks `add_service`;
`write`-group ⊆ `MUTATING_TOOLS`; `dryRun` leaves file set **and** mtimes unchanged; schema
rejects a missing `name`; every stack's executor path reaches the same service function as the
slash command; refusal matrix is identical through both entry points.

## 7. Work breakdown

Cheapest-to-prove first; each phase ends green.

1. **Shared source** — `architectureStyles.ts` + `scaffoldContext.ts` + `resolveContainerization()`. Pure addition, zero behaviour change.
2. **Capture the reference tree** — snapshot the current `monorepo-microservices` output as a
   fixture *before* touching it. Mandatory: this is what makes phase 3 safe.
3. **Decompose** `scaffoldMonorepoMicroservices` into `monorepoRoot` / `serviceBody` / `compose`
   and re-home it as the `node-ts` + `architecture: microservices` branch.
4. **Containerization layer** — `.dockerignore` writer, context-aware `writeGitignore`,
   context-aware `planForTemplate`. Retires the `php`/`dotnet` label space (F2).
5. **`showWhen`** in `TemplateOption` + `StepTemplateOptions` filter (needed by phase 6's options).
6. **Stack branches**: `node-js` (shares `serviceBody`) → `dotnet-webapi` → `php-laravel` → `python`;
   each gets microservices **and** modular monolith.
7. **Test-automation track** (independent; can run in parallel) — own document: [test-automation.md](test-automation.md).
8. **`/new-service`** — service, slash + palette wiring, `/help`.
9. **Deps plans** — context-aware cases and per-service `postCreateSteps`.
10. **Tests** — see §8.
11. **Docs** — README template table, this document's status header, one condensed CHANGELOG bullet.

## 8. Test plan

- **Drift guards** (`src/test/suite/shared/architectureStyles.test.ts`): `supportsArchitecture(id)`
  ⇔ the catalogue template carries `architectureOption()`; every `ARCHITECTURE_STYLES` value is
  handled by every stack dispatcher — this is the test that catches "added `microservices` to
  Python, forgot the branch". Plus `SLASH_COMMANDS` ⇔ `InputBar` mirror equality.
- **Matrix** — 5 stacks × `{layered, modular-monolith, microservices}`, asserting **layout**
  (module dirs, registry file, boundary config, compose present/absent), never file counts.
- **Refactor safety** — `monorepoRoot`/`serviceBody`/`compose` compared against the phase-2 fixture;
  the deprecated alias must produce a tree identical to `node-ts + microservices`.
- **Back-compat** — `options: {}` still yields the legacy layered tree.
- **Containerization invariants** — microservices always emits compose + a `.dockerignore` per
  service; `docker:false` on microservices produces a warning, not a dockerless tree; modular
  monolith with a DB/broker forces compose.
- **test automation** — the option matrix moved with the plan: [test-automation.md](test-automation.md) §10.
- **`/new-service`** — per-stack add; compose gains exactly one service and existing entries are
  preserved (hand-edited compose fixture); idempotent second run; `--dry-run` writes nothing;
  refusal matrix (layered repo, modular-monolith repo, name collision, reserved name, `../` escape);
  round-trip: wizard microservices output is parseable by the detector.
- **e2e** — add the new templates to `.ado-code/e2e/run.js`; the architecture matrix stays
  unit-level because the Electron run is slow.
- `projectDependencies.test.ts` — plans for the new context cases; test automation’s own plan lives in its doc.

## 9. Risks

- **Phase 3 is where regressions hide.** Without the phase-2 fixture the refactor is unverifiable.
- **Wide, shallow diff.** Threading a context through a 3,100-line service means touching ~9
  cross-cutting call sites; grep-count them before and after.
- **Determinism.** `.sln` and compose `.env` generation must be GUID/ordering-stable or the
  initial git commit differs run to run and snapshot tests break.
- **YAML append fragility.** Never regex-splice `docker-compose.yml`; do a minimal
  read → write that preserves comments, ordering and indentation.
- **Marker lifetime.** If someone gitignores `.ado-project.json`, detection silently degrades
  to compose sniffing — hence compose is the source of truth, not the marker.
- **Scope bleed.** `/new-service` must refuse non-microservices repos rather than guess.
- **Prompt budget.** Nothing here touches `generateSystemPrompt()`; the only exposure is
  accidentally dumping the template catalogue into the prompt (static cap 7,200 chars). Not planned.
- **CI reality.** `check:version` is CI's only gate and the suite is not run by CI — the
  pre-commit Electron wizard run is the actual evidence, plus one condensed CHANGELOG bullet.

## 10. Decisions log

| # | Decision | Rationale |
|---|---|---|
| 1 | Architecture select on server-capable templates only | a frontend has one deployable |
| 2 | No separate `monorepo-modular-monolith` template | `node-ts + modular-monolith` *is* it |
| 3 | `monorepo-microservices` removed, kept as a rewriting alias for one release | removes an architecture encoded as a stack |
| 4 | Microservices ⇒ monorepo + `services/*` + compose, for every stack | uniform, and compose is required |
| 5 | Modular monolith: docker on by default, compose forced once a DB/broker is declared | one deployable can run bare |
| 6 | `/new-service` **is** an LLM tool (`add_service`) as well as slash + palette | reversed on request: same refusal-first guards, consent via the approval card — see 6.5 |
| 7 | `--kind api\|worker` from day one | worker bodies are trivial |
| 8 | Marker at project root `.ado-project.json`, not `.ado-code/` | `.ado-code` is gitignored and per-user |
| 9 | The tool is named `add_service` and **must** join `MUTATING_TOOLS` | snake_case verb_noun per `create_work_item`; a missed gate registration fails silently |

## 11. Phase 1–3 execution notes (implemented)

Phases 1–3 of §7 are implemented and green (`npm run compile`, `npm run lint`,
`npm test` — 2385 passing). Phases 4–11 are still plan-only. Two fixtures now pin
phase 2/3 (see below), so any later change that moves the monorepo tree fails
loudly instead of silently.

**Corrections to earlier sections**

- **F3 is half wrong.** A `.dockerignore` *does* exist: `scaffoldMonorepoMicroservices`
  already writes a root one (`node_modules`, `**/node_modules`, `**/dist`, `.git`,
  `.github`, plus `deploy` when k8s is on). "None anywhere" holds for `node-ts` and
  `dotnet-webapi` only. What is still missing is the **per-service** `.dockerignore`
  §4.3 asks for, and the writer itself — phase 4 keeps both.
- **§4.3's writer signatures are aspirational.** Phase 3 shipped
  `monorepoRoot(dir, ctx, plan)`, `serviceBody(dir, ctx, plan, service)` and
  `compose(dir, ctx, plan)`: the context is threaded, but the per-stack
  parameterisation (`stack`, `tooling`, `kind`) arrives with phase 6. `kind`
  (`api` / `worker`) is **not** threaded yet — `serviceBody` still derives
  gateway-vs-domain, as today.
- **§4.2's modular-monolith row was incoherent.** "Docker opt-out allowed" plus
  "compose forced once a DB/broker is declared" can produce a compose file with no
  Dockerfiles to build. Resolved as a decision: when a DB/broker forces compose,
  Docker becomes `required` too, and a conflicting `docker:false` is dropped with a
  warning (never an error). `resolveContainerization()` enforces it; a test pins
  the "compose implies docker" invariant.
- **Phase 1 paths follow §4.1**: `src/shared/architectureStyles.ts` and
  `src/shared/scaffoldContext.ts` (host + webview share them, like
  `projectDependencies.ts`) — not under `src/shared/documentation/`.
- `ScaffoldContext.testAutomation` is deferred to the test-automation track rather
  than declared as a placeholder type with no producer.
- `ContainerizationPolicy` carries `dockerEnabled` (the effective answer) beside
  `docker: 'required' | 'optional'` (the rule). The requirement alone cannot express
  the deprecated template's carve-out below.

**Decision 10 — the deprecated template keeps its own `docker` flag.**

`resolveContainerization()` gained a transitional `honourDockerOption` input, used
only by `monorepo-microservices` in `ProjectCreationService.ts`. Without it the
§4.2 "microservices always get Docker" rule would rewrite trees for every existing
request with `docker: false`, and would contradict
`projectCreation.test.ts` ("docker option was disabled"). Phase 6 removes the flag
when the alias retires; that same phase must then update that assertion, because
`node-ts + architecture: microservices` is *supposed* to force Docker.

**Fixtures (phase 2) and the regression test (phase 3).**

`src/test/suite/services/fixtures/monorepo-microservices.tree.json` (catalogue
defaults) and `monorepo-microservices.options.tree.json` (pnpm + kafka + k8s
without docker + no gateway + no shared package, no CI, no tooling) are byte
snapshots captured from the shipped generator **before** the decomposition. The
option-heavy tree is what pins the `docker: false` carve-out, the pnpm branch, the
broker block and the two warnings — a defaults-only fixture would have left every
one of them unverified. `monorepoMicroservicesGolden.test.ts` re-scaffolds each
fixture's request and compares the whole tree, then the warnings.

**What phase 4 needs (concrete)**

1. ~~`writeGitignore(dir, ctx)`~~ — **shipped as a typed label space (F2 retired, §13.4)**:
   `writeGitignore(dir, label: GitignoreLabel)` against an exhaustive body map, which also
   fixed the two call sites that passed a template id where a label belongs.
2. A `.dockerignore` writer sized by `ctx.containerization` + `ctx.stack`, emitting
   a per-service `.dockerignore` for the monorepo shape (today's root one stays for
   the legacy template until the alias retires).
3. `planForTemplate(ctx)` (F5) — with `containerization.docker` /
   `containerization.compose` already resolved, docker and compose checks become a
   plain lookup instead of a per-template guess.
4. The drift guard from §8 (`supportsArchitecture(id)` ⇔ the catalogue template
   carries `architectureOption()`) is **not writable yet**: no template carries the
   option until phase 6. Phase 1 instead pins the capability table, the resolution
   rule and the containerization matrix in
   `src/test/suite/shared/architectureStyles.test.ts`.

## 12. Project type review (implemented)

Every project type the wizard offers, reviewed end to end: which stack it builds, how it
containerizes, and whether it can be a microservices monorepo. `docker` is the catalogue
default of the Docker toggle; "Compose" is what `planContainerFiles()` / `planMonorepoTree()`
emit for it.

| Project type | Category | Stack / runtime | `docker` default | Container files | Microservices monorepo |
| --- | --- | --- | --- | --- | --- |
| Node.js (TypeScript) | backend | node-ts | on | template writer (tailored) | yes (legacy workspace writer) |
| Node.js (JavaScript) | backend | node-ts | on | `Dockerfile` + compose | yes (TypeScript workspace) |
| Python | backend | python | on | `Dockerfile` + compose | yes (`uv` workspace, FastAPI) |
| PHP (Laravel) | backend | php-laravel | on | `Dockerfile` + compose | yes (Composer path repos) |
| .NET Web API | backend | dotnet | on | template writer (tailored) | yes (`.sln` + ASP.NET per service) |
| .NET Console | cli | dotnet | on | runtime image | no (no service to expose) |
| React (TypeScript) | frontend | react | on | nginx static build | no (frontend only) |
| Next.js | fullstack | next | on | `Dockerfile` + compose | no (frontend only) |
| React Native (Expo) | mobile | — | — | none (built on device) | no |
| Flutter | mobile | — | — | none | no |
| .NET MAUI | mobile | — | — | none | no |
| Monorepo (Microservices) | monorepo | **stack select** | on | per-service `Dockerfile` + compose | yes, for all four stacks |
| Test Automation Suite | testing | TS (Playwright/vitest/k6) | — | none (runs beside a project) | no |
| Documentation templates (BA / writer / tester) | documentation | Markdown | — | none | no |
| Empty project | — | — | — | none | no |

Three rules fall out of the table and are enforced by tests:

1. **A containerizable project type always offers the Docker toggle, defaulting on.**
   `src/shared/containerization.ts` owns the template → target map; the catalogue test fails
   when a containerizable template has no `docker` option or defaults it off.
2. **A microservices choice is never faked.** Either the stack has a writer and the monorepo is
   emitted, or the request is generated layered *and* the warning names the stacks that work.
   `monorepoStackForTemplate()` is the single table that decides this.
3. **A monorepo is scaffolded in its own stack tooling.** A `.NET`, Laravel or Python monorepo
   never contains a `package.json`, never tells the user to run `npm`, and gets a `.gitignore`
   for its own stack.

Phase 4 of this document (per-stack layout branches for the *layered* templates) remains queued;
this section covers the project types as they are offered today.

## 13. Phase 8 — `/new-service` (implemented)

One implementation behind three entry points:

| Entry point | Where | Notes |
|---|---|---|
| `/new-service` | `ChatViewProvider.runNewServiceCommand()` | `--kind api|worker`, `--dry-run`, `--description` |
| `ADO Code: Add Service` | `adoCode.addService` (`extension.ts`) | the input box validates the name against `services/*` as you type, then a kind QuickPick |
| `add_service` | `src/llm/tools.ts` | registered in `ToolName`, `NativeToolArgs`, `TOOL_GROUP_MAP.write`, `TOOL_DISPLAY_NAMES` **and `MUTATING_TOOLS`** |

All three call `ProjectCreationService.addService()` — plan first, write second — and render the
outcome through `describeAddServiceResult()` (`src/shared/addServiceReport.ts`) so the wording
cannot drift between them. The pure half — marker parsing, name rules, compose handling and
every file patcher — lives in `src/shared/serviceScaffold.ts` with no `fs` import, which is
what the tests exercise directly.

### 13.1 What the tests changed in the design

1. **A worker is identified by its start command, not by an extra file.** `serviceSupportsWorker()`
   keys on `workerCommand()`, so Laravel — which runs `artisan queue:work` from the api's own
   code and generates no second entrypoint — counts, while `dotnet` is refused instead of
   producing a portless container that runs the api's entrypoint and does nothing.
2. **Every patcher is append-only or returns `null`.** `appendCiMatrixService()` learned the
   wizard's own inline flow sequence (`service: [a, b]`) as well as block lists, and
   `appendArchitectureService()` adds a row with the header's column count to the
   `## Service catalog` **table** the wizard generates. A file that cannot be parsed is
   reported to the caller, never reformatted.
3. **A dry run reports the same warnings as a real run.** `addService()` returns the warning
   list on both paths and the formatter prints it on both paths — the preview used to return
   before the warnings were rendered.

### 13.2 Deliberate refusals

`/new-service` refuses, with the reason and the next step, when the folder is not a
microservices repo (it points at `/new-project`), when the name is not kebab-case, is reserved
(`shared`, `contracts`, `infra` — `gateway` is *not* reserved) or already exists, and when
`--kind worker` is asked of a stack with no worker host. The name check runs before any write,
so a second identical run is a refusal and never a duplicate.

### 13.3 Still open

The dependency plans and the doc sweep in phases 9–11. Phase 4 has no residual left: F2 was
retired in §13.4.

### 13.4 Phase 4's F2 residual — retired

`writeGitignore` took a free-form `templateId: string` and fell back to `node_modules/` for
anything it did not recognise. Two call sites were wrong in ways nothing caught:
`scaffoldMonorepoReadme` passed `ctx.templateId` — a template id standing in for an ignore
label — and the ternary in `scaffoldStackMonorepo` passed `dotnet-webapi`, a label that does not
exist, so a .NET monorepo quietly received the Node body. The standalone `test-automation`
template matched nothing either and got `node_modules/` from the fallback by accident.

The label space now lives in `src/shared/gitignoreTemplates.ts`:

- `GitignoreLabel` is the union of every body the scaffolder can write, and
  `GITIGNORE_TEMPLATES` is an exhaustive `Record<GitignoreLabel, string>` — a label without a
  body, or a body without a label, fails the build.
- `gitignoreContent(label)` is total, so the wrong-bytes failure mode is gone rather than
  merely detected: there is no default arm to fall through.
- `gitignoreLabelForStack(stack)` is an exhaustive `Record<MonorepoStackId, GitignoreLabel>`,
  which is the .NET monorepo regression (dotnet → `/bin/`, never `node_modules/`).
- `isGitignoreLabel(value)` narrows a free-form string (a persisted option, an id read back
  from disk) instead of leaving callers to invent a default. `isGitignoreLabel('dotnet-webapi')`
  is deliberately `false` — that string is the bug.
- `test-automation` is a real label now, carrying tooling ignores only: the suite keeps owning
  `node_modules/`, `dist/` and the report folders through `IGNORE_LINES`.

`writeGitignore(dir, label)` is three lines, and `gitignoreTemplates.test.ts` pins the label
space, the stack mapping and both regressions. `php` and `dotnet` stay shared labels (the
deprecated `php` alias and the two .NET templates reuse them) rather than becoming an id
space of their own.

---

## 14. Standard alignment — ZEN Engineering Handbook

The boilerplate emitted by this pipeline is now measured against an external standard as well as
against its own tests. The review, the clause-by-clause verdicts, the corrections to the first
reading, the ready-to-paste handbook amendments and the phase plan live in
[zen-handbook-review.md](zen-handbook-review.md); this section only records how the work relates to
the phases above.

**Decisions (review §3).** (D1) Where the handbook is stricter than the emitted baseline, the
baseline moves — no clause is satisfied by documentation alone. (D2) Monorepo stays the default
topology: the handbook's per-service repository layout is amended instead, with `contracts/` at the
repository root, one matrix pipeline, and the hexagonal split kept inside each service. (D3)
Handbook rules become executable — emitted files, then a named preset, then the managed `AGENTS.md`
block; the free-text scaffolding prompts are demoted to a fallback. (D4) Clauses get ids
(`ZEN-STD-*`) so gates and evidence reports can cite them.

**Phases (review §8).** **P1 container hardening — shipped (§14.1)** · **P2 contract-first
`contracts/` — shipped (§14.2)** · P3 observability and lifecycle (`/metrics`, JSON logs,
correlation id, `/healthz/live|ready`, SIGTERM drain) · P4 resilience kit · P5 CI gates, compose DB
and k8s hardening · P6 `zen-microservices` preset plus the `AGENTS.md` managed block · P7 ADR
document type and clause-id traceability.

P1–P5 change what §2.3 and §13 describe, so they land before any further template work: a new
template added first would have to be retrofitted through every one of them. None of P1–P7 changes
the pipeline stages of §2.1 — they are writer-level changes, plus one preset row in P6.

**Clause score.** At the time of the review (`814f011`) §4.2 runtime standards stood at **0 of 6
fully met**, 3 partial and 3 unmet; §4.3 CI gates at 1 of 7 met, 2 partial, 4 unmet. P1 moved CON‑01
and P2 CON‑02 to met — **2 of 6** now. Both are expected to reach "all met" at the end of P5.

### 14.1 P1 — container hardening (shipped)

The clause CON‑01 rules are now emitted, not documented: `src/shared/containerHardening.ts` is the
single source for container policy and every Dockerfile writer consumes it.

- **`BASE_IMAGES`** — every base image pinned to a full `major.minor.patch` tag
  (`node:20.18.0-alpine3.20`, `python:3.12.7-slim`, `php:8.3.13-cli`, `composer:2.8.1`,
  `dotnet/sdk:8.0.403`, `dotnet/aspnet:8.0.10`, `dotnet/runtime:8.0.10`,
  `nginxinc/nginx-unprivileged:1.27.5-alpine3.21`). Minor-only pins (`node:20-alpine`) drift
  silently on the next upstream rebuild; digest pins are stronger still and remain a follow-up.
- **`hardeningLines(family, port)`** — the non-root `USER` plus `HEALTHCHECK` tail, behind an
  exhaustive `never`-checked switch over the runtime families (`node-alpine`, `python-debian`,
  `php-debian`, `dotnet-web`, `dotnet-console`, `nginx-static`). Each HTTP family probes its own
  port with the interpreter that actually exists in that image (`wget`, `urllib`, `php -r`,
  `curl`), because `slim` has neither `curl` nor `wget`. `dotnet-console` is the one family with
  no `HEALTHCHECK` — it serves no endpoint to probe, and the test asserts that exception rather
  than tolerating it.
- **Multi-stage everywhere.** PHP (composer install in `build`, artefacts copied into `runtime`)
  and Python (venv built in `build`, copied over) were single-stage; .NET web and console, Node and
  the static targets were already staged or joined them.
- **Unprivileged static servers.** React/Next moved from `nginx:1.27-alpine` on `EXPOSE 80` to
  `nginxinc/nginx-unprivileged` on **8080** — an unprivileged container cannot bind a privileged
  port, so the previous pair only worked *because* it ran as root.
- **Start commands restored.** Writing the assertions exposed four real defects: the .NET monorepo
  service had lost its `CMD` in the multi-stage rewrite, PHP and Python monorepo services had no
  start command at all (`docker run` exited immediately), and `node-ts`/`node-js` relied on an
  inherited base-image command Alpine does not define.

Evidence: `src/test/suite/shared/containerHardening.test.ts` (10 tests) walks every monorepo stack
and every containerizable catalogue template, asserting ≥2 `FROM … AS` stages, a non-root `USER`,
a `HEALTHCHECK` (except the console family), a full-patch base image with no `:latest`, and a start
command; `monorepoStacks.test.ts` asserts against `BASE_IMAGES` so the pins cannot drift from the
tests. `HEALTHCHECK` targets `/health` and moves to `/healthz/live` in P3 — named in one constant so
the rename is a one-line change.

Suite evidence: **2581 passing, 0 failing** (2571 before P1 + 10 new), 2 pending. Measured
per-directory on this machine — the `git` and `services` batches do real I/O and together exceed the
runner's 20 s hook timeout when all 161 files share one mocha process, which fails the `gitService`
suite rather than any assertion. Each batch is green; no test was changed to make it pass.

### 14.2 P2 — contract-first (shipped)

CON‑02 asked for a machine-checkable contract instead of types only TypeScript can read.
`src/shared/contractArtifacts.ts` is now the single source for it: pure data plus pure functions,
so every writer — the node monorepo writer and the Python/.NET/Laravel tree planners — consumes
the same planner.

| Artifact | Path | Content |
|---|---|---|
| OpenAPI document | `contracts/openapi/<service>.v1.yaml` | OpenAPI 3.1.0: list/create/read on `/api/v1/<resource>`, `GET /health`, `ApiError` + `HealthResponse` components, `x-publishes` per event |
| Event envelope | `contracts/events/envelope.v1.json` | JSON Schema 2020‑12 — `eventId`, `eventType`, `timestamp`, `source`, `payload` required; `correlationId`, `version` optional |
| Event schemas | `contracts/events/<event>.v1.json` | one self-contained schema per published event, `eventType` pinned with `const` |
| Folder README | `contracts/README.md` | per-service/per-event table, the additive-change rule, the `redocly lint` gate |

Four decisions worth recording:

- **No YAML dependency.** The repo is zero-runtime-dependency, so `toYaml()` is a purpose-built
  block-style writer for the subset an OpenAPI document needs. It quotes whatever YAML would
  reinterpret (`'#/components/schemas/X'`, `'200'`, `'true'`, `'a: b'`) and is deterministic: the
  same plan produces byte-identical output, which is what makes a golden fixture possible at all.
- **Event schemas are self-contained.** Each restates the envelope rather than `$ref`-ing
  `envelope.v1.json`, because cross-file `$ref` is resolved differently by every validator and
  editor plugin. A test asserts every event schema's `required` list is exactly `ENVELOPE_REQUIRED`,
  so the duplication cannot drift.
- **The gateway gets no contract.** It forwards `/api/v1/*` verbatim to the owning service, so its
  public surface is the union of the others; a document for it would duplicate every path.
- **`/health` stays outside the prefix.** The Dockerfile `HEALTHCHECK` and the orchestrator probes
  depend on it, and P3 renames it to `/healthz/live` in one place — `HEALTHCHECK_PATH`.

`/api/v1` is now the only way in: the node service and gateway routes, plus the Python
(`@app.get("/api/v1/…")`), .NET (`MapGet`) and Laravel (`apiPrefix: 'api/v1'`) writers.
`/new-service` stamps the new service contract as well — an OpenAPI document for an `api`,
event schemas for both kinds, none for a `worker` (it serves no HTTP surface). Existing files are
never overwritten: a contract a team has since edited wins, and the command reports the collision
as a warning.

Protobuf is **not** emitted: the catalogue has no gRPC stack, so CON‑02 is met through OpenAPI
plus JSON Schema only. Adding a gRPC stack is a P6-era decision, not contract plumbing.

Tests: `contractArtifacts.test.ts` (27 tests) — YAML quoting and determinism, `$ref` resolution
against the document's own components, envelope/event `required` parity, the naming helpers, and a
walk over every monorepo stack asserting one contract per domain service and that no route file
still serves the bare unprefixed service name. `projectCreation.test.ts` asserts the emitted paths
and a pinned `eventType`; both golden fixtures were regenerated (11 and 8 contract files).
