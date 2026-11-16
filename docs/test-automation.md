# Test Automation Scaffolding — Plan

> **Status: SUITE GENERATOR AND WIZARD WIRING IMPLEMENTED; the rest is plan-only.**
> `src/shared/testAutomationSuite.ts` emits the suite, the standalone `test-automation`
> template writes it at the project root, and the `testAutomation` option group on the five
> stack templates writes it under `tests/` (§4, §5, §7, §9). Still open: the `qaDocs`
> hand-off to the documentation renderer (the generator takes the files as a hint nobody
> passes yet), the §5 option ids exactly as written (the shipped group uses `e2e`/`api`/
> `perf` booleans instead of a single `testAutomation` select) and the §8 dependency-case
> refinements. Split out of [project-scaffolding.md](project-scaffolding.md) §5, which keeps
> only the pointer and the sequencing constraint. Sections marked **Finding** were verified
> against the code; §2 also records one earlier assumption that verification disproved.

## 1. Scope

| In | Out |
|---|---|
| A standalone `test-automation` project template — a runnable suite repo, not a document set | Extending `doc-tester`'s document set; the renderer and its options stay untouched |
| A `testAutomation` / `perfTests` / `ci` option group on the server-capable app templates | Replacing the unit-test setup each app scaffolder already emits (vitest / jest / xUnit) |
| One shared suite generator, called by both entry points | A `testing` step in the wizard, or a second wizard pass |
| An opt-in `qaDocs` render of the existing tester doc set into the new template's `docs/` | Any change to `build_documentation`, `DOC_PROJECT_SPECS` or `list_doc_templates` |

The goal is that a tester can be pointed at *any* freshly generated repo — either a suite-only
repo, or an app repo that already carries a passing suite — without hand-assembling Playwright,
an API client, k6, reporting and CI wiring first.

## 2. Verified current state

| # | Finding | Location |
|---|---|---|
| T-F1 | `testerDocs()` returns `DocFileSpec[]` **only** — a pure document renderer, no executable artefacts | `src/shared/documentation/docTemplates.ts:1081` |
| T-F2 | The same spec set is consumed by the `build_documentation` tool, so it is a public contract, not wizard-internal | `DOC_PROJECT_SPECS:1595` |
| T-F3 | `doc-tester` options are `includeTestCases` / `includeUat` / `evidenceCapture` — document-shaped; no automation artefact anywhere in the set | `docTemplates.ts` |
| T-F4 | `PROJECT_TEMPLATES` holds 16 ids and **no `testing` category** exists | `ProjectCreationWizard/types.ts:66`, category union `:6` |
| T-F5 | `TemplateOption` has no conditional visibility, so suite-specific options (`perf`, `reporting`) would show for every project | `types.ts` |
| T-F6 | **Correction:** `dotnet-webapi` carries **no** test flag. Only `dotnet-maui`, `react-native` and `flutter` have a `testing` option (they emit a unit-test project). `node-ts` advertises "optional ESLint, Prettier, and testing setup" in its description (`:70`). An earlier assumption that .NET web already had an xUnit flag to reuse was wrong — there is nothing to reuse |
| T-F7 | Unknown ids in `planForTemplate` fall through to a git-only plan with **no warning**, so a suite that needs `npx playwright install` would silently report "nothing needed" | `src/shared/projectDependencies.ts` |
| T-F8 | The creation test loops every template with default options, so a new template is auto-covered but its **option branches are invisible** | `src/test/suite/services/projectCreation.test.ts:109` |

## 3. Decision: its own template, with a bridge

**A standalone `test-automation` template, not a `doc-tester` continuation.** Grounds (T-F1/T-F2):
putting runnable Playwright/k6 code in the doc set would make a *documentation* tool emit an
executable repo, give every tester document set an install/build lifecycle it does not want, and
mutate a public tool contract for a wizard feature.

The bridge is an **opt-in `qaDocs` option, default off**: the new template can render the existing
`testerDocs()` output into its own `docs/` folder by calling the same renderer. Testers get the
Test & UAT paperwork *and* a runnable suite, without merging the two lifecycles.

**Deliberate limitation:** the suite is **TypeScript + Playwright / vitest / k6 for every app
stack**. Testers exercise HTTP and UI, not the app's own language, so this removes a whole
language matrix at zero cost.

## 4. Template layout

```
e2e/        playwright.config.ts, specs/, fixtures/, pages/
api/        vitest config, http client, request/response fixtures        (option: api)
perf/       k6 smoke script                                              (option: perf)
testdata/   seed data + generators
reporting/  html or allure config, evidence/ folder                      (option: reporting)
ci/         .github/workflows/test.yml | azure-pipelines.yml             (option: ci)
docs/       optional tester doc set, rendered from testerDocs()          (option: qaDocs)
.env.example, README.md (how to run, how to read a trace), CHANGELOG.md
```

`README.md` is part of the deliverable, not boilerplate: a tester who cannot run the suite from
the README in five minutes has been handed a broken template.

## 5. Options

| Option | Type | Default | Notes |
|---|---|---|---|
| `e2e` | bool | `true` | Playwright; `showWhen`-gate `reporting` on `e2e \|\| api` |
| `api` | bool | `true` | vitest + fetch client; cheap enough to be on by default |
| `perf` | bool | `false` | k6 smoke script only — no load profiles |
| `reporting` | select `html \| allure \| both` | `html` | `allure` adds the results folder + config |
| `ci` | select `none \| github \| azure` | `none` | one workflow, runs whatever exists |
| `sample` | bool | `true` | emits one **passing** smoke spec so `npm test` is green out of the box |
| `qaDocs` | bool | `false` | renders `testerDocs()` into `docs/` |
| `baseUrl` | input | `http://localhost:3000` | written to `.env.example` |

`sample` defaults to **on** on purpose: a suite repo whose first `npm test` fails is worse than no
template, because the failure looks like a scaffolding defect.

## 6. Option group on app templates

`testAutomation` (select `none | playwright | api | playwright+api`, default `none`) plus
`perfTests` (bool, `showWhen` `testAutomation !== 'none'`) and `ci` on:

`node-ts`, `node-js`, `python`, `php-laravel`, `dotnet-webapi` — and on any of those created with
`architecture: 'microservices'`, where the suite covers all services from the repo root.

`dotnet-webapi` gains the group outright (T-F6: there is no existing flag to reuse).
`dotnet-maui`, `react-native` and `flutter` keep their existing `testing` flag and are **out of
scope** — adding a second, competing test switch to those templates would be a UX defect, not a
feature.

Default `none` means every existing template request produces exactly the tree it does today.

## 7. Generator

One function, two callers:

```ts
scaffoldTestAutomationSuite(dir, opts, hint): { files, warnings, postCreateSteps }
```

| Caller | Target | Behaviour |
|---|---|---|
| `test-automation` template | project root | full suite as listed in §4 |
| app templates (`testAutomation !== 'none'`) | `tests/` | same suite, rooted one level down; **never edits app source** |

Both paths share the emitters, so a suite bug is fixed once. The writer contributes ignore lines
(`test-results/`, `playwright-report/`, `.playwright/`, `allure-results/`, `perf/reports/`) through
the options-aware `writeGitignore` from [project-scaffolding.md](project-scaffolding.md) (finding
F4) — the current `writeGitignore(dir, templateId)` signature cannot express them.

`qaDocs` reuses the documentation renderer; it does not fork it.

## 8. Dependencies and install

- `planForTemplate` gains a context-aware `test-automation` case: node/npm required (T-F7 — the
  git-only fallback must stop being the answer for an unknown id).
- `npx playwright install --with-deps` becomes a **`postCreateStep`**, not part of auto-install:
  it downloads browsers and may fail behind a corporate proxy. Failure ⇒ warning, never a failed
  create — the same pattern as the existing MAUI warning.
- k6 is **documented, not installed** (single binary, platform-specific); the script and the run
  command live in the README.
- Auto-install stays **root-only** — the multi-manifest rule from the main plan applies here too.

## 9. Catalogue and UI

- Category union gains `'testing'`; `CATEGORY_LABELS` gains `testing: 'Testing & QA'`.
- New entry `test-automation` with the §5 options.
- `TemplateOption.showWhen` (main plan, phase 5) is a **prerequisite** for `perf` / `reporting`
  gating; without it the options step shows controls that write nothing.

## 10. Tests

- `projectCreation.test.ts` — the default-options loop (`:109`) auto-covers the template; add an
  option matrix for `ci` × `reporting` × `sample`: expected file set, and `reporting` absent when
  both `e2e` and `api` are off.
- `sample: true` emits a spec that **asserts** (`expect(true).toBe(true)`-class, or a
  self-contained page test); the suite never runs it.
- `e2e: false, api: false` ⇒ no `e2e/`, no `api/`, and the README does not reference them.
- App-template path: `tests/` exists, app source untouched (assert the app's own files are
  byte-identical apart from the ignore file), `testAutomation: 'none'` (and a wholly options-less
  request) still yields the legacy tree.
- Drift guard: every catalogue template whose id is `test-automation` and every template carrying
  `testAutomation` must be handled by the generator's dispatcher — the test that catches "added the
  option, forgot the branch".
- `projectDependencies.test.ts` — `test-automation` plan, plus the playwright `postCreateStep` and
  its warn-don't-fail behaviour.
- `qaDocs: true` ⇒ the tester doc set appears under `docs/` **and** `build_documentation`'s own
  output is unchanged (contract guard for T-F2).
- `.ado-code/e2e/run.js` — add `test-automation` to the wizard-create assertion list; the option
  matrix stays unit-level because the Electron run is slow.

## 11. Decisions log

| # | Decision | Rationale |
|---|---|---|
| T1 | Test automation is its **own template**, not a `doc-tester` continuation | separate lifecycle from document sets; keeps `build_documentation`'s contract intact |
| T2 | `qaDocs` opt-in, **default off**, renders the existing tester doc set into `docs/` | bridge to Test & UAT with zero changes to the doc renderer |
| T3 | Suites are TypeScript + Playwright/vitest/k6 for **every** app stack | testers work over HTTP/UI; avoids a language matrix |
| T4 | App-template group defaults to `testAutomation: 'none'` | every existing request must keep producing today's tree |
| T5 | `dotnet-webapi` gains the group; `dotnet-maui`/`react-native`/`flutter` keep their existing `testing` flag | no second competing test switch (T-F6) |
| T6 | `sample` defaults on | a first `npm test` that fails reads as a scaffolding defect |
| T7 | Playwright browser download is a warned `postCreateStep`, never a hard requirement | corporate proxies; create must not fail on a download |

## 12. Risks

- **Browser download** is the most common first-run failure; the warning must name the command to
  re-run, not just report the exit code.
- **The "green out of the box" promise** (T6) is only true if the sample spec is self-contained —
  no `baseUrl` dependency, so `npm test` works before any app exists.
- **`qaDocs` is the only place this doc touches another feature's contract**; T-F2 is the guard.
- **Catalogue drift** — the template entry, the generator's dispatcher and the deps plan are three
  separate switch points; the drift test in §10 is what keeps them aligned.
- **CHANGELOG/docs budget**: one condensed bullet, and this document is the design record — no
  per-feature .md addition later.

## 13. Sequencing

Independent track — it does **not** depend on the architecture work. Two prerequisites are shared
with [project-scaffolding.md](project-scaffolding.md):

1. `TemplateOption.showWhen` + the `StepTemplateOptions` filter (phase 5 there) — for `perf` /
   `reporting` gating.
2. Options-aware `writeGitignore` (phase 4 there) — for the suite's ignore lines.

Once those land, this track can be built in either order relative to the per-stack architecture
branches: template → generator → deps plan → tests → docs.
