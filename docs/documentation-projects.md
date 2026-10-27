# Documentation projects

Three project templates for documentation work, offered by the **New Project** wizard
(`/new-project`) under the *Documentation* category:

| Template | For | Role code |
|---|---|---|
| **Business Analysis** (`doc-ba`) | business analysts — requirements, process, stakeholders | `BA` |
| **IT Documentation** (`doc-writer`) | technical writers — design, user, operational and API docs | `WR` |
| **Test & UAT** (`doc-tester`) | testers — test plan, cases, evidence, defects, UAT sign-off | `TS` |

They are separate projects on purpose (a BA team and a test team are usually different
people, sometimes different organisations), but they are **designed to join**: see
[Identifier vocabulary](#identifier-vocabulary).

---

## What gets created

Folders appear only when their option is enabled, so a project is never padded with
empty directories.

```
doc-ba/                                   doc-writer/
  README.md                                 README.md
  .ado-code/documentation.json              .ado-code/documentation.json
  00-project-control/                       00-project-control/
    project-charter.md                        document-plan.md
    document-control.md                       document-control.md
    glossary.md                               glossary.md
    document-register.csv                     document-register.csv
    krisa-compliance-matrix.md †              krisa-compliance-matrix.md †
  01-business-analysis/                     01-design/
    brs.md  functional-requirements.md         srs.md  system-design.md
    stakeholder-register.md                    data-model.md
  01-process/ ‡                               interface-specification.md
    process-as-is.md  process-to-be.md      02-user-docs/ §
  02-requirements/ ‡                          user-manual.md  administrator-guide.md
    non-functional-requirements.md             training-guide.md  faq.md
  05-traceability/ ¶                         03-operations/ ‖
    rtm.md  rtm.csv                            deployment-guide.md  ops-runbook.md
  06-change-control/ ✳                       04-api/ ‖
    change-request-template.md                  api-reference.md
    change-request-log.md                       integration-spec.md
  inputs/                                    05-traceability/ ¶
    README.md  source-register.csv             requirements-mapping.md
    brd/ frs/ nfr/ pas/ ptb/ str/ cht/ crt/   06-change-control/ ✳
    _general/                                inputs/ …
  assets/                                    assets/
    media-register.csv  README.md  img/        media-register.csv  README.md  img/
  export/ …                                  diagrams/  export/ …

doc-tester/
  01-test-planning/test-plan.md
  02-test-cases/ §  test-scenarios.md  test-cases.md  traceability-test-cases.md
  03-uat/ ‖  uat-plan.md  uat-script.md  uat-signoff.md
  04-defects/ ✳  defect-log.md  defect-triage.md  test-evidence-register.csv
  05-traceability/ ¶  rtm.md  rtm.csv
  06-evidence/ †  test-summary-report.md  security-test-report.md
  inputs/ ‡‡  assets/evidence/  diagrams/  export/ …
```

† KRiSA governance only · ‡ `includeProcess` / `includeNfr` · § `includeUserDocs` /
`includeTestCases` · ‖ `includeRunbooks` / `includeApiDocs` / `includeUat` ·
¶ `traceability` · ✳ `docControl: Full` (or KRiSA) · ‡‡ `captureInputs`

`README.md` is generated from the file list that was actually written, so the project
map can never go stale. `.ado-code/documentation.json` records the machine-readable
facts (`framework`, `language`, `role`, `docSet`, `naming`, `wordExport`, `xlsxExport`,
`linkedProjects`) — it is what makes a later cross-project roll-up possible without
guessing.

---

## Identifier vocabulary

One vocabulary across all three templates, so the projects join on shared keys:

| Prefix | Meaning | Originates in |
|---|---|---|
| `REQ-###` | functional requirement | BA |
| `NFR-###` | non-functional requirement | BA |
| `BR-###` | business rule | BA |
| `TC-###` | test case | Tester |
| `UAT-###` | UAT script step / scenario | Tester |
| `EX-####` | test execution (one attempt) | Tester |
| `DEF-###` | defect | Tester |
| `CR-###` | change request | any |
| `IN-###` | source input (notes, transcript, sketch) | any |
| `EVD-###` / `FIG-###` / `DIA-###` | evidence / figure / diagram file | any |

The join is `REQ-### → TC-### → EX-#### → EVD-###`. Test cases **never invent** a
requirement id; if the BA project is separate, the tester references the BA's
`REQ-###` verbatim.

### Registers and their column contracts

Every register is a CSV whose header is generated from one exported constant in
`src/shared/documentation/columns.ts`, and the same columns appear in the Markdown
tables and in the exported workbook — a test pins the three representations to the
same string.

| Constant | Register |
|---|---|
| `RTM_COLUMNS` | `05-traceability/rtm.csv` — requirement → ADO work item → design ref → test case → UAT status |
| `EVIDENCE_COLUMNS` | `04-defects/test-evidence-register.csv` — one row per **execution** |
| `MEDIA_COLUMNS` | `assets/media-register.csv` — one row per **file** (screenshot, figure, diagram) |
| `DOCUMENT_COLUMNS` | `00-project-control/document-register.csv` — the document-control page |
| `INPUT_COLUMNS` | `inputs/source-register.csv` — the audit trail of raw material |

Two evidence registers exist because they answer different questions: `EVIDENCE_COLUMNS`
answers *"what happened when we ran TC-014?"* (with build, environment, expected/actual,
witness), while `MEDIA_COLUMNS` answers *"is this file the one that was signed off?"*
(`SHA-256`, capture time, classification). Cross-linked by `MEDIA-ID`.

Enumerated columns (`RESULT`, `BLOCKED-REASON`, `ENVIRONMENT`, `CLASSIFICATION`, `STATUS`,
`TYPE`) ship with a fixed vocabulary, validated by a test — free-text `RESULT` (`ok`,
`PASS!`) is the commonest reason a register cannot be summarised at sign-off.

The default team header row, in order:

```text
EXEC-ID, TEST-CASE-ID, REQ-ID, CYCLE, SCENARIO, BUILD-VERSION, ENVIRONMENT,
EXECUTED-UTC, EXECUTED-BY, WITNESSED-BY, STEP-REF, EXPECTED, ACTUAL, RESULT,
BLOCKED-REASON, DEFECT-ID, RETEST-OF, EVIDENCE, REMARKS
```

The first four are **join keys** and keep their positions permanently, so RTM and evidence
joins never break; team-specific columns are appended at the end rather than inserted.

Two of them exist for reasons that only show up at sign-off:

- **`CYCLE`** (`SIT-1`, `UAT-1`, `UAT-2`) — execution happens in rounds and sign-off quotes
  the round, not the build. One round can span two builds, so `BUILD-VERSION` alone cannot
  answer *"what was the pass rate in UAT round 2?"*.
- **`BLOCKED-REASON`** — required when `RESULT` is `Blocked`, blank otherwise. It is
  enumerated (`Environment unavailable`, `Test data missing`, `Blocking defect`,
  `Access denied`, `Dependency not delivered`, `Other`) because a free-text reason makes
  *"how many were blocked by an environment outage?"* unanswerable, and an execution
  blocked with no reason is the first thing an auditor asks about.

Columns filled by the tooling rather than typed: `EXEC-ID`, `CAPTURED-UTC`, `HASH-SHA256`
(media register), `RECEIVED-DATE` (inputs register) and `EXECUTED-UTC` on capture. Everything
else is typed once — at execution time, while the tester still remembers what happened.

> **Team-specific evidence columns:** `EVIDENCE_COLUMNS` is the default set. If your team
> already has a register, paste its header row into that constant — every consumer
> (Markdown tables, CSV, XLSX, `test-summary-report.md`, `uat-signoff.md`) is generated
> from it, so it is a single-file change.

---

## Source inputs

Every documentation project can carry the raw material its documents derive from —
meeting notes, transcripts, sketches, screenshots, vendor PDFs, emails.

```
inputs/
  README.md            index: folder → document → doc-id → what belongs there
  source-register.csv  one row per input (IN-###), with LINKED-DOC and LINKED-REQ
  brd/  frs/  nfr/  …  one folder per *sourced* document
  _general/            anything that is not yet attributable
```

Decisions worth knowing:

- **Only sourced documents get a folder.** The RTM, KRiSA matrix, change-request log,
  document-control page and glossary are *derived* — a folder for them would be a place
  to put nothing. `INPUT_EXCLUDED_DOC_TYPES` encodes that rule.
- **The register is the audit trail, not the folder.** `INPUT_COLUMNS` carries
  `RECEIVED-DATE`, `SOURCE-DATE`, `FROM`, `LINKED-DOC`, `LINKED-REQ`, `STATUS`
  (`Received → Triaged → Incorporated`, plus `Superseded`/`Rejected`), `CLASSIFICATION`
  and `HASH-SHA256`.
- **Recordings are registered but not committed.** `mp3/mp4/wav/m4a/mov/mkv/webm` under
  `inputs/**` are gitignored (`INPUT_RECORDING_PATTERNS`); transcripts stay committed.
- Each folder README carries a tickable checklist: original untouched, `INPUT-ID`
  assigned, `LINKED-DOC`/`LINKED-REQ` set, personal data redacted.
- `captureInputs: false` writes no tree, omits the `## Source inputs` section from every
  document, and records `inputs: null` in `documentation.json`.

---

## KRiSA governance

`governance: KRiSA (Government)` switches the project into KRiSA mode. For non-government
work, `Standard` leaves all of it off.

What KRiSA mode adds:

| Addition | Why |
|---|---|
| `00-project-control/krisa-compliance-matrix.md` | artefact · phase · owner · status · sign-off date · evidence link · guideline reference |
| `06-change-control/` | configuration/change control is mandated regardless of `docControl` |
| `06-evidence/security-test-report.md` (tester) | security testing evidence |
| `document-control.md` deliverable table | lists source **and** distributed artefact |
| `TERHAD` / `RESTRICTED` classification | replaces `INTERNAL` in the document header block and the print banner |

Coercions are **forced and reported**, never silent. If the wizard is asked for
`wordExport: None`, `xlsxExport: None` (tester) or `includeSecurity: false` under KRiSA,
the option is overruled and a warning comes back to the wizard toast.

> ⚠ **Not claimed as compliant yet.** `src/shared/documentation/krisa.ts` holds the
> artefact catalogue as data, and **every `guidelineRef` currently reads
> `TODO — confirm clause`**. The artefact list is drafted from the phases a government
> application-development guideline of this shape normally mandates (initiation →
> requirements → design → configuration management → security testing → UAT →
> deployment/training → post-implementation review). Correcting names and clauses is a
> single-file edit; until that is done, no output should be presented as KRiSA-compliant.
> The matrix lists only the artefacts owned by that project's role — a BA project does
> not claim the tester's evidence.
>
> Reference: [Garis Panduan Pembangunan Aplikasi KRiSA (Beta 2026)](https://sqa.jdn.gov.my/index.php/ms/garis-panduan/garis-panduan-pembangunan-aplikasi-krisa-versi-beta-2026)

---

## Format: Markdown in, Word/Excel/PDF out

**Markdown with YAML front matter is the source of truth** — diffable, reviewable in a
pull request, editable by both the human and the AI agent. Every other format is
*derived*; never hand-maintain a Word copy alongside the Markdown, or the
document-control page and the body will drift.

The front matter drives the cover page, footer and print banner in every output:

```yaml
---
doc-id: acme-BA-BRD-001
title: Business Requirements Document (BRD)
version: 1.0.0
status: Draft            # Draft | In Review | Approved
owner: Business Analyst
approver: TBC
classification: INTERNAL # or TERHAD / RESTRICTED under KRiSA
lang: en                 # en | ms | bilingual
ado-work-item: 27123
---
```

Bahasa Malaysia documents use the BM keys (`id-dokumen`, `tajuk`, `versi`,
`pemilik-dokumen`, `pelulus`, `klasifikasi`, `bahasa`) — the parser maps both spellings
onto the same fields, so there is no separate BM code path.

### Export paths

| Path | Command | Best for |
|---|---|---|
| **In-product Word** | doc-tree **Export…** → *Word* | one click, no install; cover page, A4, footer with page numbers, embedded images |
| **Pandoc scripts** | `export/export.ps1` (or `.sh`) | corporate reference-docx styling, TOC field, tracked changes, PDF via a TeX engine |
| **Registers → Excel** | **Export…** → *Registers* | dropdowns for enumerated columns, real date cells, hyperlinks to evidence |
| **Diagram PNG** | **Export…** → *Diagram* | rasterise a Mermaid block for a manual |
| **HTML** | decided at authoring time | print-to-PDF in a browser (the chat webview has no `font-src`, so the print CSS uses system fonts only) |

The export runs **in the webview** (`docx` + `fflate` are bundled there, lazily), and the
result is written through the same save bridge as every other binary export.

Both halves read the **same** front matter and the **same** block model
(`src/shared/docBlocks.ts`), so a cover page and footer match between the in-product
Word file and the pandoc output.

### What Word export cannot do

Mermaid diagrams are **not** rendered into DOCX — they are reported as a warning naming
the line (`Diagram at line 87 omitted from Word: export it as PNG first`), because a
silently missing diagram in a submitted document is worse than a visible warning.
Rasterise the diagram, reference the `.png`, and it embeds at the correct size (the
intrinsic dimensions are read from the PNG/JPEG/GIF/WebP/SVG header and fitted to the A4
content width at 96 dpi).

---

## Screenshots and evidence

| Class | ID | Where | Purpose |
|---|---|---|---|
| Evidence | `EVD-###` | `assets/evidence/` (tester) | proof an execution happened |
| Figure | `FIG-###` | `assets/img/` | illustrative screenshot in a manual |
| Diagram | `DIA-###` | `diagrams/` (`.mmd` + `.svg` + `.png`) | workflow / architecture |

A screenshot without an ID and a register row is decoration, not evidence — so the
capture path assigns the next free `EVD-###`, writes the file, appends the register row
and records `SHA-256` + capture time. Production data must be redacted and the row
classified `TERHAD`/`RESTRICTED` under KRiSA.

Diagram source lives beside the rendered image: `diagrams/DIA-003.mmd` (source),
`.svg` (vector), `.png` (what the document embeds). `diagramTool: plantuml|drawio` ships
`.puml`/`.drawio` placeholders, but only Mermaid is rasterised in-product.

---

## Where things live

| File | Responsibility |
|---|---|
| `src/shared/documentation/columns.ts` | column contracts + vocabularies + CSV writer |
| `src/shared/documentation/krisa.ts` | KRiSA artefact catalogue (edit clauses here) |
| `src/shared/documentation/docTemplates.ts` | the three role specs and every document body |
| `src/shared/documentation/docInputs.ts` | inputs tree derivation, index, per-folder READMEs |
| `src/webview/documentation/scaffoldDocs.ts` | the scaffolder: coercions, registers, export pipeline |
| `src/shared/docBlocks.ts` | Markdown + front matter → block model (no dependencies) |
| `src/shared/docxLayout.ts` | layout decisions: cover, A4 geometry, banners, table widths |
| `src/webview-ui/src/export/docxRenderer.ts` | block model → `docx` |
| `src/shared/xlsx.ts` | workbook model → OOXML parts |
| `src/webview-ui/src/export/xlsxRenderer.ts` | parts → ZIP (`fflate`) |
| `src/shared/svgRaster.ts` | Mermaid SVG → `data:` URI plan, size clamping |
| `src/webview-ui/src/export/mermaidRaster.ts` | `mermaid.render` → canvas → PNG base64 |
| `src/shared/imageSize.ts` | intrinsic image dimensions, A4 content-width fitting |
| `src/webview/documentation/exportDocumentation.ts` | host half of the export round trip |
| `src/webview-ui/src/export/documentationExport.ts` | webview half: request → render → save |
| `src/shared/documentation/exportPayload.ts` | the wire contract (validated both sides) |
| `src/shared/binaryExport.ts` | save-bridge policy: naming, folders, MIME, filters |
