# Changelog

All notable changes to ADO Code will be documented in this file.

## [Unreleased]

## [0.8.5] - 2026-11-13

### Added

- **`explore_codebase` — an in-process, read-only search subagent.**
- **Three `AGENTS.md` invariants are now tests.** `specInvariants.test.ts` pins zero runtime dependencies (including optional/peer), exactly one non-test `generateSystemPrompt()` call site, and an `api-version` allowlist …
- **Review gate before a clean finish — the harness can now see a turn that ends wrong.** A tool-call-free reply used to be accepted on trust.
- **Reflection turn at a loop halt — the loop can now recover instead of confessing.**
- **Turn outcome counters — the first feedback loop on model behaviour.**
- **The memory tools are now actually available to the model, and it can withdraw an entry it wrote.**
- **Memory digests are ordered newest-first, so the budget drops the oldest entries instead of the newest.**

### Fixed

- **The Setup Wizard opened to a blank page (0.8.4 regression).**
- **The Setup Wizard no longer opens in both areas when the chat lives in an editor tab.**
- **`signals.iterations` was never incremented.** The turn-outcome counters and the reflection digest reported 0 iterations for every turn that finished normally; only the limit path filled the field.

## [0.8.4] - 2026-11-05

### Added

- **What's New is reachable from the first second of activation, including a fresh install.**

### Changed

- **The system prompt is ~20% smaller, its dead policy text is live again, and the static prefix is now cacheable.**
- **The repository-understanding block is capped per part instead of wholesale.**
- **A size-budget test guards the prompt against creep.**
- **A turn that runs out of iterations now leaves the goal and to-do list in a state the next turn can resume from.**
- **The setup wizard no longer asks for an Azure DevOps project — it tells you whether the ADO configuration actually works.**
- **The chat's three verbosity knobs are now one dial — in Configuration and in the kebab menu.**

### Fixed

- **The Setup Wizard remembers your settings when you re-open it.**
- **"Extension loading" no longer leaves you staring at a bare spinner.**
- **A decision raised by a running turn no longer lands in whichever chat you happen to be looking at.**
- **A finished turn no longer keeps claiming it is still "Working…".**
- **The /new-project dependency check no longer needs a VS Code restart.**
- **The remote tunnel check now finds a cloudflared installed after launch.**
- **Agent detection and agent runs use that same fresh PATH.**

## [0.8.3] - 2026-10-30

### Added

- **The remote console is now a single-page app, opened by the QR code.**
- **Choice cards answered on either surface now close on both.**
- **The project wizard now checks dependencies before it scaffolds.**
- **Guidance when the host cannot comply on its own.** Installing a runtime or an SDK needs elevation, a licence or a multi-GB download, so ADO Code never attempts it: a missing tool shows its paste-ready per-OS command …
- **Autonomous half of the check.** What the host *can* fulfil itself — project packages (`npm install`, `pip install -r requirements.txt`, `composer install`, `dotnet restore`, `flutter pub get`) — rides a …
- **Tool approvals are answerable from the phone.** The remote console now renders the consent and confirmation cards the desktop chat shows — **Allow once / Allow for session / Always / Deny**, or one button per option …
- **`/new-project` now scaffolds mobile apps and monorepo microservices.** Thirteen templates instead of nine.
- **Remote oversight shows the job that is still progressing when the phone joins.**
- **The "Working now" card: oversight follows the built-in chat turn too.**
- **The conversation itself is mirrored to the console — and can be continued from the phone.**
- **The session plan — goal and to-do list — is on the console too.**
- **The Remote Oversight console gained a Goal view and a Files view.**
- **Tool calls now show up in Remote Oversight.** The console mirrored the conversation and the approvals, which left a hole: a call that needed no consent …
- **Inlined under the answer that made them, in the Thread view.**

### Changed

- **Verification is now cheap by default: the test suite runs headless, and the Electron host is opt-in.**
- **`npm run test:changed` runs only the suites a diff touches.**
- **`npm run test:host` keeps the real VS Code host available**
- `tsc` now runs with `incremental: true`, cutting a repeat compile from ~16s to ~3s.
- **The dependency step now walks you through Flutter *and* its Dart SDK, following the official install docs.**
- **The Flutter steps were re-reviewed line by line against docs.flutter.dev/tools/vs-code.**
- **The console opens on the newest message, pins the reply box and makes Send hard to miss.**
- **The Remote Access panel can now turn remote access off, and re-pick its settings.**
- **The remote console's bottom tabs are readable.** Labels were 14px at 62% opacity over an already-muted colour - roughly 4:1 contrast on a phone held at arm's length - and the selected state was …
- **The empty Runs view explains itself.** "Nothing running right now" read as a defect.
- **Tiered testing is now the default ADO Code writes into AGENTS.md.**

### Removed

- **Obsolete plan and promo documents.** `docs/` no longer carries executed implementation plans: `remote-agent-oversight-plan.md` (superseded by `docs/remote.md`, which documents the shipped console) …

### Fixed

- **`npm run lint` is green again — the six pre-existing errors, none of them behavioural.**
- **A new objective now retires the old goal instead of renaming it, so one chat can no longer accumulate a fifty-step pile.**
- **The item cap prunes instead of silently swallowing new steps.**
- **The tool descriptions and system prompt now state the consequence of the merge semantics.**
- **A tunnel QR no longer scans to a link without its session token.**
- **A phone reload no longer answers "This link is missing its access token".**
- **A cloudflared tunnel no longer answers `{"error":"forbidden host"}`.**
- **The Electron test harness no longer exits 1 having reported no tests at all.**
- **A message typed on the phone ran the turn but left no bubble in the desktop chat.**
- **Choice blocks carried no options on the console.** The mirror re-parsed the *answer text* for a `choice` fence, so a choice that reached the desktop as a `choicePrompt` frame — or came from a numbered list or the …
- **A network hiccup no longer ends a turn with "fetch failed".**
- **A trailing slash in `adoCode.llmApiUrl` no longer turns every request into a 404.**
- **The What's New panel no longer truncates every changelog entry after its first line.**
- **A restored chat no longer empties itself a moment after it appears on screen.**
- **The chat reopens on the session you were last in, even after VS Code is killed.**
- **An answered choice card no longer returns as live "waiting for input" on the phone.**
- **Answering a question on the phone now closes the option card in VS Code.**

## [0.8.2] - 2026-10-29

### Added

- **Remote Agent Oversight is now reachable from the Configuration page.**

### Fixed

- **The Configuration page no longer dies on the first setting VS Code refuses.**
- **The Remote Access status-bar toggle explains a stale window instead of failing.**

## [0.8.1] - 2026-10-28

### Added

- **Remote Agent Oversight** — a phone-sized console that mirrors agent runs off this machine.
- **Remote console transport** — loopback HTTP server with an SSE stream, a 256-bit token in `SecretStorage` traded once via `POST /session` for an `HttpOnly` cookie, and a `Host` guard that rejects rebinding-style …
- Six `machine`-scoped settings (`adoCode.remote.enabled|bind|port|tunnel|tunnelCommand|` `tunnelUrlPattern`) plus `extensionKind: workspace`, since the console is a service on the machine that runs the …

### Notes

- Remote access is **off by default** and binds to loopback only. The `adoCode.remote.*` settings are `machine`-scoped, so enabling it on one machine does not follow a synced settings profile onto …

## [0.8.0] - 2026-10-28

### Added

- **Documentation projects for business analysts, technical writers and testers**
- **KRiSA (government) governance mode** — `governance: KRiSA (Government)` turns on a 26-artefact catalogue (`src/shared/documentation/krisa.ts`), a per-role compliance matrix, `TERHAD`/`RESTRICTED` classification, and …
- **Export to Word, Excel and PNG from the chat panel** — an export bar appears for documentation projects with Word / Registers / Diagram actions.
- **Source-inputs tree** — each documentation project gets `inputs/<doc-type>/` folders plus an `inputs/source-register.csv` (Received, Triaged, Incorporated) so meeting notes, transcripts and sketch scans are traceable to …
- **Tool calls can be shown or hidden straight from the chat** — hiding them used to mean a trip to Settings.
- **Generated artifacts are collected and their context cost is visible**
- **Context budgets across every artifact ADO Code generates**
- **The repository-understanding cache is indexed in JSON and maintains itself**
- **Memory injected into a prompt is budgeted, and oversized writes are refused**
- **Documentation projects can be scaffolded from chat**

### Fixed

- **Exported Mermaid diagrams lost their labels** — mermaid 12.1.0 honours only root-level `htmlLabels`, so `flowchart.htmlLabels:false` in `EXPORT_INIT_DIRECTIVE` was silently ignored and every exported diagram carried …
- **A new documentation project pointed at folders that did not exist**
- **"Export diagram" always failed** — `normaliseExportRequest` required `diagramLine` for `diagram-png`, but the export bar cannot know a fence's line number without parsing the whole document, so every real export was …
- **A to-do update replaced the list instead of editing it**
- **Work-item creation fails when the user may not create tags**
- **"Latest answer" pins the chat to the bottom instead of jumping once**
- **A chat message survives an abrupt shutdown (laptop power-off, sleep, host kill)**

## [0.7.5] - 2026-10-16

### Added

- **Agent delegation works without an ADO work item or a selected project**
- **Work-item-less delegation is complete (AD-04/AD-05/AD-06)**

### Fixed

- **Concurrent delegations for one work item no longer collide on a branch, and an oversized prompt no longer kills the run**
- **Concurrent prompt-only delegations no longer share a git branch**
- **A work-item-less run no longer leaks the missing work item into the completion UI**
- **A work-item id mentioned anywhere in the CHANGELOG no longer suppresses that item’s completion entry**
- **The CHANGELOG entry written when a work item is closed no longer carries the wrong title or a misleading branch pointer**
- **The task branch created on a one-click agent handoff is no longer slugged from the previously active work item**

## [0.7.4] - 2026-10-13

### Added

- **The chat reopens in the Editor Area after an IDE restart**

### Changed

- **`set_goal` and `update_todo_list` no longer consume the agentic iteration budget**
- **Marketplace categories** — `categories` changed from `["Other"]` to `["AI", "Azure"]`, so the extension is listed under the AI and Azure sections of the VS Code Marketplace and Open VSX instead of only the catch-all …
- **Marketplace keywords** — a `keywords` list (`azure devops`, `work items`, `ai`, `ai coding assistant`, `agentic`, `llm`, `openai`, `anthropic`, `mcp`, `model context protocol`) was added so the extension surfaces for …

### Fixed

- **The new-project wizard scaffolds into a blank folder instead of nesting a project directory inside it**
- **Refreshing the ADO project list can no longer hang on "Fetching projects…"**

## [0.7.3] - 2026-10-08

### Fixed

- **The packaged `.vsix` no longer contains `.env`** — the gitignored `.env` (registry publish tokens) was excluded by `.gitignore` but missing from `.vscodeignore`, and vsce packages from `.vscodeignore`, so `0.7.2` …

## [0.7.2] - 2026-10-08

### Fixed

- **`create_work_item` no longer reports a phantom "cancelled by user" when the AI batches draft creation**
- **A message typed while a tool is running now interrupts that tool instead of waiting for it**
- **A long tool command no longer pushes the approval card's buttons (and the input bar) off-screen**
- **Agent worktree creation is now Windows-safe** — `GitService.createWorktree` created its base directory by spawning the `mkdir` binary with -p…
- **Headless `vscode` stub: `ThemeIcon` now retains its `ThemeColor`**
- **Moving the chat into the Editor Area no longer drops an open in-chat prompt**
- **Webview unit suites are green again — the `ChatViewProvider` tests were failing on an incomplete mock**
- **Webview tree and mermaid suites are green again — the headless `vscode` stub now models `TreeItem`, `ThemeIcon` and `MarkdownString` for real**
- **`createNewSession()` can no longer mint two sessions with the same id**
- **`npm test` no longer dies before it starts when the shell already lives inside Electron**
- **The Electron harness's Windows temp-directory cleanup no longer stalls or leaks**
- **The consent-gate suite no longer runs real `git` mutations against the repository**

### Maintenance

- **Removed two redundant config tests**
- **Licensing metadata added — the project is now MIT** — It was publicly distributed (GitHub plus Marketplace `.vsix`) with no `LICENSE`, no `package.json` `"license"` field and no README licence…
- **Removed `src/llm/providers/BaseProvider.ts`** — Its two strict-mode tool-schema helpers (`convertToolsForOpenAI`, `convertToolSchemaForOpenAI`) were verbatim Roo-Code code with no…
- **Reworded the last Roo-Code attribution comments** — the three file headers in `src/llm/tools/types.ts`, `src/llm/modes.ts` and src/llm/prompts/system.ts…
- **Regenerated the tracked webview bundle** — (`webview-ui-dist/webview.js`, committed build output) — so the artifact matches the reworded CSS
- The one live export of that module, the `ContentBlockText` / `ContentBlockImage` / `ContentBlockParam` types, moved to `src/llm/types.ts`
- **Packaging: `.github/**` and `.husky/**` are now excluded from the `.vsix`**
- **Open VSX publishing is now scripted — `npm run publish:open-vsx`**
- **The marketplace icon is a real PNG again** — `resources/icon.png` was a JPEG (JFIF) renamed to `.png` — 428 KB of mislabelled image that VS Code and Open VSX both advertise as a PNG

## [0.7.1] - 2026-10-05

### Performance

- **Activation no longer loads the whole extension graph, or builds services it may never use**

### Bug Fixes

- **A chat could mint a brand-new session id on every request**
- **Outbound User-Agent reported a version that never shipped**
- **Version drift is now blocked in CI, not just by local hooks**

## [0.7.0] - 2026-10-01

### New Features

- **Queue vs. steer for mid-run input** — (`adoCode.chat.inputWhileBusy`, default `steer`) — choose what happens when you type while the AI is working
- **AI delegation suggestions** — (`adoCode.chat.suggestDelegation`, default on) — the assistant can recommend handing a coding task to an installed external agent, and the chat renders a compact suggestion card…
- **Chat density modes** — (`adoCode.chat.density`, default `comfortable`) — an explicit three-way control over the chat's per-turn detail
- **`View Archived Goals` affordance in the To-do view**

### Improvements

- **Steering is non-destructive** — steering a running turn no longer aborts it
- **Chat-area declutter — readability first** — long, tool-heavy turns no longer bury the answer under execution chrome
- **Session-scoped To-do view** — the view now renders only the **active chat session's** goal and steps, so switching sessions resets the panel to that session's list…
- **Superseded goals are archived, not discarded** — when a new goal & to-do list is created for a session after the previous goal was fully completed…
- **Archive lifecycle** — deleting a chat session removes its archive too (`removeSession`); the plain To-do `Clear` intentionally keeps the archive…
- **One error banner, everywhere** — the Configuration page carried its own error banner *and* auto-dismiss timer — a second implementation of the chat view’s banner…

### Fixes

- **Switching sessions no longer aborts a running turn**
- **Warned before a background run is stopped**
- **`/remember` now actually remembers** — it previously wrote to a workspace-keyed notes store nothing ever read, so remembered notes never reached the model
- **Session name updates as soon as the topic is known**
- **Running badge in the session list** — a session that is still generating — including one still working in the background after you switched away…
- **Enter works mid-turn, multi-line input stays readable, history stops auto-jumping** — three chat-view UX fixes
- **Configuration page surfaces every contributed setting**
- **Catalog-drift guardrail** — a new unit test (`configCatalog.test.ts`) fails the build whenever a contributed `adoCode.*` setting is not surfaced in the Configuration…

### Tests

- New `shared/sessionRun` suite: turn/session visibility (live output only ever reaches the session that owns the run)…
- New `shared/sessionRun` `sessionRunInfo` cases: idle returns no badge, the on-screen session's run is reported as foreground…
- New `runAgenticChat` steering suite: a steered message lands on the *next* iteration (not the current one)…
- New `shared/toolActivity` and `shared/attachments` suites: folding consecutive tool calls into activity rows (`Ran N tools` labels + name…
- New `shared/turnSummary` suite: count-based turn metrics (tool calls, reasoning blocks…
- New `shared/chatNavigation` suite: the jump-to-latest visibility rule (thresholds, short content…
- New `shared/chatDensity` suite: mode normalization (whitespace/casing tolerance, unknown-value fallback to `comfortable`)…
- New `shared/transientStatus` suite: the status-line headline derivation (activity precedence, reasoning-aware `Working…`/Reasoning……
- New/updated `TodoStore` and `TodoTreeProvider` suites: archive-on-supersede, incomplete goals not archived, per-session archives…

### Internal

- **Single source for the model-capability heuristic** — the vision/tool inference logic was duplicated between the extension host (`src/llm/modelCapabilities.ts`) and the Configuration page…
- **Webview re-exports shared host types** — the hand-mirrored `AgentName`/`AgentCapability`/`AgentRun` and `Skill*` type copies in `src/webview-ui/src/types.ts` are now re-exported…
- **Configuration page split into focused modules**
- **Data-driven setting rendering; derived Advanced count** — the Configuration page's ~65-line setting.type === … ?
- **`saveConfig` payload is validated; the settings map is typed**
- **One source for the webview ↔ host message contract**
- **Configuration page styles are co-located**
- **Configuration contract hardening (R-series)** — three latent couplings in the Configuration UI were removed

## [0.6.7] - 2026-09-30

### New Features

- **Session To-do list and goal** — (`To-do` view + `set_goal` / `update_todo_list` tools)

### Improvements

- **Workspace memory entries are readable and openable from the status panel**
- **Thinking & Tools record now survives a session reload**
- **Tool cards: completed calls never render as "running"**
- **Reasoning can no longer be prepended to an answer**
- **A streamed reasoning delta can no longer absorb the start of an answer**
- **Live turn header no longer repeats the block label**
- **Tests** — new suite for turn-trace persistence (capping, re-persist stability, restore round-trip, repeated-answer pairing)

## [0.6.6] - 2026-09-26

### Improvements

- **Per-org PAT support** — `adoCode.organizations` entries now accept an optional `pat?` field — a per-organization Personal Access Token that overrides the global…
- **Windows-safe temp-directory cleanup (`cleanTempDir`)**
- **Claude adapter Windows shim resolution** — Added `resolveBin(name)` helper to `ClaudeAdapter` that walks `PATH` and prefers `claude.cmd` (npm shim) over `claude.exe` over the bare…
- **Release notes moved out of README** — The `## Release Notes` section in `README.md` has been replaced with a link to CHANGELOG.md…
- **Token counting & context budgeting overhaul**
- **Dedicated workspace `delete_file` tool**
- **Quote-aware shell operator sanitization**
- **Windows `cmd.exe` builtin command routing**
- **Degenerate tool loop detection & circuit breaker**
- **Regex parsing with inline flags & `flags` parameter in `search_files`**
- **Collapsible, dismissible, and session-isolated confirmation cards**
- **Batch `read_file` via `paths` & elevated 400-line window**
- **Turn-scoped file read cache**
- **`list_workspace` file size details**
- **Header menus and commands**
- **Move chat into Editor Area & return to sidebar**
- **Interactive Mermaid chart rendering**
- **Export & copy Mermaid charts as SVG**
- **Extension branding and Activity Bar icons**
- **Unattached project option & standalone mode**

## [0.6.5] - 2026-09-08

### Improvements

- **Every LLM request carries a user-agent**
- **"Review Task Detail" is now an AI review** — Right-click a work item → Review Task Detail no longer only opens the detail — it binds the item to the chat and hands it to the AI…
- **One work item per session** — Sessions now remember which ADO work items they processed and show them as #chips in the session-history dropdown
- **Work-item hover shows the ID** — Work-item tree tooltips now open with `#<id> · <title>` in addition to the existing type/state/assignment details
- **Command palette refreshed**
- **Auto-approve harmless commands runs instantly**
- **Iteration budget defaults to 100** — `adoCode.act.toolBudget` (Iteration budget) now defaults to 100 with the recommendation "100+"…
- **Model pickers are dropdowns in Configuration → Advanced**
- **Token counting includes tool + image content** — The local heuristic counter now charges for every block actually passed to the LLM — tool-call argument JSON on assistant messages…
- **YOLO still asks before pushing** — Pushing code to the remote repository — the `push_worktree` tool OR a terminal `git push` — now requires approval even in YOLO mode

## [0.6.4] - 2026-09-08

### Improvements

- **Maxed-out turns conclude in the chat instead of erroring**
- **Iteration counts stay model round-trips, not tool calls**
- **Structure-first, read-lazy project study** — To save context and turns when exploring an unfamiliar codebase, the model is now guided to orient on directory structure and doc files…
- **AGENTS.md keeps itself current** — AGENTS.md is now a managed file kept in sync with the repository understanding (`.ado-code/understanding/`) instead of a one-shot template
- **Mixed-batch tool calls stay parallel**
- **Batch work-item reads**
- **Batch terminal commands**
- **Wizards take over the sidebar**
- **"Configuration…" opens the in-app Configuration page**
- **Agentic turns leave an ordered record that stays visible after the loop ends**
- **Chat splits into two sides** — AI answers stay on the left; your messages move to the right as a compact bubble — button-colored…
- **No more (AI)/(You) label circles** — The little avatar circles carrying the speaker label next to each message are removed
- **Chat turns always conclude** — A turn that ends right after tool work with no closing text (or a provider returning an empty final) previously vanished from the thread…
- **Delegated runs keep the chat alive and conclude in place**
- **Chat sessions no longer interfere with each other** — A chat turn is now bound to the session that started it — it reads/writes only that session's buffer and only posts progress while…
- **Streamed answers are buffered and flushed safely** — Partial replies stream in the live bubble and materialize as a single normal message at completion…
- **Every timeout shows a countdown with a named post-timeout action**
- **Prompt timeouts pause while you're away** — A pending consent/confirmation card no longer ticks down while you're not looking at it
- **Top-of-panel error banners auto-dismiss** — Host errors (ADO/LLM fetch and save failures) shown in the banner at the top of the chat panel now disappear on their own after 8 seconds…
- **Agent detection matches what your terminal can run**

### Fixed

- **Configuration-page PAT/org/project saves now take effect**

## [0.6.3] - 2026-08-28

### Improvements

- **New Project wizard creates projects anywhere** — The wizard previously always failed with "No target path specified" — the webview sent an empty target folder for the host to resolve…
- **Empty-workspace prompt opens the full wizard** — The "Create New Project" offer shown in an empty folder used an old limited inline flow (6 templates, no options, no review)…
- **Wizard template defaults apply even when you skip the options step**
- **Wizard git branch name is honored** — The "Initial Branch Name" field was collected but ignored — `git init` used whatever your machine's default branch happens to be
- **ADO integration creates the work item** — The ADO Integration step collected work-item type and area path but did nothing with them
- **Wizard errors are visible again** — Create failures used the global error banner, which sits behind the wizard's full-screen overlay…
- **Scaffolded projects are more solid** — Laravel scaffolds now include the missing `bootstrap/app.php` (artisan couldn't run) and emit valid PHP namespaces…
- **Project-name validation** — Empty or path-traversing project names are rejected up front with a clear message instead of writing outside the target folder

### Fixed

- **24 new tests covering every project type** — Each of the 9 templates (Node TS/JS, Python, PHP Laravel/plain, .NET Web API/Console, React, Next.js, Empty) is now exercised end-to-end…

## [0.6.2] - 2026-08-25

### Improvements

- **Images inside work items are now retrieved and displayed**
- **Work Items view shows assignment at a glance** — Each item is now marked with an assignment cue — a **blue person** = assigned to you, an **orange person** = assigned to someone else…

### Fixed

- **Numbered task lists are now posted to ADO**
- **Numbered/bulleted sub-items inside task descriptions no longer lost**
- **Changelog comments posted to ADO are now cleanly formatted**
- **Created work items render their descriptions correctly in ADO**

## [0.6.1] - 2026-08-23

### Improvements

- **Cached repository + work-item understanding** — ADO Code now keeps a durable, fingerprinted understanding of the active repository and the selected ADO work item…
- **DeepSeek Harness as a delegation agent** — `dsh` is now a first-class external agent — detected via `dsh --version`, delegatable from chat, `/delegate`, the work-item context menu…
- **Proper tree structure for the Work Items tree** — The tree now renders the real ADO hierarchy instead of flat roots
- **Merged Work Items view with mode toggle** — My Work Items, All Work Items, and Unassigned Work Items are now ONE tree view ("Work Items") with a **visible mode header row** at the top…
- **Parallel tool execution (pi parity)** — Independent tool calls in a single model turn now run concurrently instead of one-after-another…
- **Per-file mutation queue** — Parallel batches that edit the SAME file are serialized (read-modify-write can't interleave)…
- **Truncated-response guard** — When the model hits its output token limit (`length`/`max_tokens`), tool calls are NOT executed — arguments may be truncated mid-JSON…
- **Batched edits**
- **`search_files` grep tool is now real** — Previously advertised in the prompt but unimplemented, it now greps the workspace with a JS regex — `path:line` hits…
- **`execute_skill` tool works again** — The system prompt told the model to call `execute_skill`, but the executor couldn't run it — every attempt errored as "unknown tool"
- **External skill registries** — Browse and install community skills from remote TSV registries (`slug<TAB>url<TAB>description`)
- **Smarter prompt guidance** — The system prompt now tells the model to issue independent tool calls in the same request (so the parallel loop is actually used) and…
- **Live agent progress in the editor** — Agent delegation progress can now be moved to the editor area
- **Parent delegation completes child items** — Delegating a parent work item (Story, Feature, Epic) now covers its **whole descendant subtree** — children, grandchildren, and beyond…
- **Main-model choice offers (zero extra cost)** — When the model's answer ends by offering you a choice ("Should I … or …?"), it now appends a fenced ` ```choice block with 2–6 short…
- **Active editor context auto-injected per turn** — The file you're editing is now automatically included in each chat turn's context, so the assistant sees the code you're actually working…
- **Slimmer session persistence** — Sessions now persist only the last 25 complete user/assistant message pairs (plus the leading condensation/truncation marker) instead…
- **AGENTS.md honored in chat** — The chat system prompt now instructs the model to read and honor an `AGENTS.md` at the workspace root when present…
- **Iteration budget clarified**
- **Provider-native token counting refined** — Native counting is now forced ON for Anthropic (its `/count_tokens` endpoint is free) and stays opt-in for OpenAI-compatible gateways via…

### Fixed

- **Tolerant `System.Parent` parsing**
- **Conversation summaries silently dropped on Anthropic**
- **Laravel scaffold generated broken PHP** — The `artisan` and `routes/web.php` templates used `\C`/`\$` escapes that JavaScript template literals silently collapse…
- **Security: dompurify bumped to 3.4.14** — in the webview bundle (fixes the flagged moderate vulnerability)
- **dsh delegation for existing users** — Users whose stored `adoCode.agents.enabled` predates DeepSeek Harness (the previous default list) silently lost dsh…

### Changed

- **Tree diagnostics in Output → ADO Code**
- **Single tool implementation path** — Removed the legacy Roo-Code-style layer (`BaseTool`, `ToolRegistry`, the `definitions/` schemas, and the five per-tool classes)…
- **Docs updated** — `docs/playbooks/add-tool.md` rewritten for the single-path architecture, `docs/chat-token-optimization.md` refreshed with the new…
- **Lint-clean + dead code removed**
- **Test runner env hook**

## [0.5.9] - 2026-08-21

### Improvements

- **Live thinking + tool progress in chat** — While the AI works, the chat window now streams its reasoning into a 💭 Thinking block and shows every tool call as a live card…
- **Permanent tool-call record** — When the turn finishes, the tool cards are merged into the assistant message above the answer as collapsible blocks…
- **Hide tool calls in chat** — New `adoCode.chat.showToolCalls` setting (default on, in Configuration → Chat) hides the tool cards — tools still run normally…
- **Show AI thinking is now enforced** — The existing `adoCode.chat.showThinking` toggle (Configuration → Chat) previously had no effect — thinking text was always displayed
- **Wildcard permissions** — Two ways to grant broader permission "to a certain extent"
- **Wildcard-aware session approvals** — "Allow for Session" choices also honor patterns, so approving `git *` once covers every git command for the rest of the session
- **Token consumption optimization for the agentic loop**
- **Provider-native token counting**
- **Accurate token budget** — context truncation/condensing and the status bar now account for the system prompt + tool schemas that ride along with every request…

### Changed

- **Reorganized Configuration UI**
- **Advanced Configuration is now a real category** — The Advanced toggle (in the sidebar) gates a dedicated **Advanced** category that bundles the per-mode model selection…

## [0.5.8] - 2026-08-15

### Improvements

- **Skill Catalog UI overhaul** — Redesigned with pill-style category filters, search with icon and clear button, accent stripes on cards…
- **Activity indicator in chat** — Shows a spinner + text banner while executing skills ("Executing skill: Code Review…") or generating tasks ("Generating tasks…")…
- **Instant chat refresh** — Session switches and history restores now jump straight to the latest message instead of scrolling from top to bottom
- **Skill persistence** — Imported skills now survive VS Code restarts — full skill data is stored in globalState, not just IDs
- **Fixed "Execute in Chat"** — Previously sent the skill prompt to the extension but never injected it into the chat…

### Features

- **Skill import from local files** — Import skills from .json files, SKILL.md files (YAML frontmatter + markdown body), or .tar.gz/.tgz/.zip archives containing skill packages
- **Expanded builtin skills** — 4 new builtin skills — Deployment Checklist, Database Schema Review, Accessibility Audit (now 10 total across 10 categories)
- **Local skill import button** — "+" Import button in the Skill Catalog toolbar opens a file picker supporting all skill formats
- **Send Selection to Chat** — Right-click any selected text in the editor → "ADO Code: Send Selection to Chat" inserts it as a fenced code block in the chat draft…
- **Send File to Chat** — Right-click a file in the Explorer → "ADO Code: Send File to Chat" attaches it as a chip above the input bar with full content ready to send
- **Delete All Sessions** — New `/clear-sessions` slash command + "🗑️ Delete All Sessions" button in the session history dropdown and kebab menu…
- **Confirmation cards for destructive operations** — Single session delete and delete-all now show in-chat confirmation cards instead of silently executing
- **Categorized `/help`** — The help output is now grouped into Work Items, Chat, AI, and Other sections with a tip about autocomplete

### Fixed

- **Configuration settings not persisting** — Advanced Configuration toggle, consent auto-approve settings, agent auto-review, chat show-thinking, per-mode model config…
- **Missing VS Code settings declarations** — Added `adoCode.consent.harmlessAutoApprove`, adoCode.consent.harmlessAutoApproveSeconds…

## [0.5.7] - 2026-08-09

### Features

- **Task draft editor**
- **YOLO mode** — New fully-autonomous mode that auto-approves every tool including shell commands — no consent prompts, no allowlist
- **Consent auto-approve timer** — Harmless (read-only) terminal commands (git status/diff/log, npm test, ls, cat, etc.) show a countdown timer on the consent card…
- **Show AI thinking** — Models that return thinking/reasoning tokens (o1/o3 reasoning_content, Claude extended thinking) now display their internal reasoning in…
- **Improved context size detection** — Content-aware token counting (code ~3.5 chars/token, prose ~4.5) replaces naive char/4 estimation…
- **Dynamic context window from API** — Context window size is now auto-detected from the `/models` endpoint — Ollama `meta.n_ctx`, OpenRouter `context_length`, and other providers
- **Context management** — Priority-based conversation truncation replaces naive 20-turn cutoff; real token counter replaces rough char/4 estimation…
- **Mode-aware system prompt** — Dynamic prompt generation includes mode-specific role, available tools, tool guidelines, environment context, and memory injection
- **Tool budget configurable** — Max tool calls per act-mode turn now adjustable in the Configuration page (recommended: 15-30) with min/max constraints
- **MCP server management** — Right-click MCP servers in the Status Panel to disconnect, reconnect, or view details
- **Mode quick-cycle** — Right-click the Mode item in the Status Panel to cycle through inline/plan/act
- **Worktree batch cleanup** — Remove All Completed action on the Worktrees root node
- **Agent run history**
- **Agent details panel** — Right-click agent in Status Panel to view name, binary, version, supported modes, and CLI arguments
- **Memory search** — QuickPick fuzzy search across all user and workspace memory entries
- **Memory import/export** — Export memories to JSON; import with merge or replace option
- **Keyboard shortcuts** — Ctrl+Shift+M cycle mode, Ctrl+Shift+/ search memories, Ctrl+Alt+R refresh status
- **Worktree diff viewer** — Show Changes opens VS Code diff editor for worktree files
- **Agent auto-review** — Git diff automatically reviewed by LLM on agent completion with merge recommendation
- **Work item filtering** — Filter Work Items tree by state, type, or text search with smart parent visibility
- **Changelog on update** — After a version change, a one-time notification offers to show the new version's changelog in a styled webview panel
- **Generate tasks from user story** — New `create_work_item` LLM tool creates ADO work items; `/generate-tasks` slash command and context menu action trigger the AI to analyze…
- **Agent progress in chat** — Agent delegation now shows start/completion messages in the chat thread alongside the streaming output panel
- **Merge-flow guardrails round 2**
- **Child task delegation** — When delegating a work item to an agent (via `delegate_to_agent` tool or `/delegate` slash command)…
- **Clean Up After Merge** — New context-menu action on the Worktrees view and auto-offer after a merged PR — removes the run's worktree and deletes its branch…
- **Capability overrides**
- **Live model capabilities**
- Removed redundant "Select Work Item" context menu entry (was duplicated across two menu groups)

### Bug Fixes

- **Choice-card answers went stale** — Clicking an option on an AI-posed question posted `sendMessage`, which the host silently dropped…
- **"spawn git ENOENT" on legacy worktrees** — Commit & Push / Clean Up After Merge failed on worktrees created by older versions (`run-run-…` directories)…
- **Pre-commit hook git env var pollution**

## [0.5.6] - 2026-08-07

### Features

- **Capability overrides**
- **Live model capabilities** — Detection is now three layers — user override > live gateway data > name heuristic
- **Protected PR targets** — `adoCode.git.protectedBranches` (default `["main", "master"]`) — `create_pull_request` refuses to open a PR against a protected base…
- **Merge-flow guardrails** — Committing a FAILED agent run is refused unless the assistant explicitly passes `allowFailed` (after reviewing)…
- **Clean Up After Merge** — New context-menu action (and auto-offer after a merged PR) that removes the run's worktree and deletes its branch…

### Bug Fixes

- **Choice-card answers went stale** — Clicking an option on an AI-posed question posted `sendMessage`, which the host silently dropped…
- **"spawn git ENOENT" on legacy worktrees** — Commit & Push / Clean Up After Merge failed on worktrees created by older versions (`run-run-…` directories)…

## [0.5.6] - 2026-08-06

### Features

- **Dedicated Worktrees view** — New sidebar tree showing every agent worktree with per-worktree details — run status (color-coded), agent, work item, dirty/clean files…
- **Reopen agent output** — Closed summary panels are no longer lost — finished runs get a "↗ Reopen" button and a "Reopen output" link in the chat panel…
- **Memory-driven agent hooks** — Workspace memory keys `agent.before` and `agent.after` hold shell commands that run around every agent invocation…
- **Model capability checking** — The extension infers the active model's capabilities (`vision`, `tool calling`) from its id
- **Model list retrieval in Configuration**
- **`.ado-code` auto-ignore** — The workspace data directory (memory, checkpoints, agent runs) is now offered to be added to `.gitignore` and `.dockerignore` when missing…
- **AI merge flow** — The assistant can now execute the whole merge flow for a finished agent run itself via three new tools…
- **Worktree merge guardrails** — `delegate()` refuses a second concurrent run on the same work item (both would share a branch) and warns when an existing branch is behind…
- **Working indicator** — A status-bar spinner (`$(sync~spin) Working…`) shows while any LLM turn or agent run is in flight — host-side…
- **Background processing survives view changes** — Closing/hiding the chat panel no longer force-denies pending consent mid-turn — the LLM loop keeps running host-side…
- **AI choice detection (LLM-assisted)**
- **Sessions auto-create** — The first chat message now creates a session (named from the message) — no more "No sessions yet" for users who never clicked New Session…
- **Full Configuration page coverage** — Every contributed setting now round-trips through the page — including a structured **Organizations** editor (name/URL/project)…

### Improvements

- **Branch names use the ADO subject**
- **Tree view title bars cleaned up**
- **Worktree directories named after the run** — Directories under `.ado-code/worktrees/` are now exactly the run id (no `run-run-…` double prefix)…
- **Consent deny-once per command** — After one consent denial in a turn, only the SAME tool (or exact terminal command) is auto-denied for the rest of the turn…
- **"Allow for Session" for every tool** — All mutating tools now offer it on the consent card (was terminal-only); approvals skip the prompt and are cleared when the chat is cleared…

### Bug Fixes

- **Dismissed agent runs no longer reappear** — Dismissing a finished run is now persisted host-side, so panel remounts, re-focus, and extension reloads keep it dismissed
- **Duplicate agent summary panels** — Reopening a summary while its panel is still open revealed a second panel — it now reveals and refreshes the existing one
- **Worktree branch labels were commit hashes** — `git worktree list --porcelain` puts the branch on a `branch` line — the parser read the bare `HEAD` hash…
- **"No sessions yet" despite chatting** — The first message now auto-creates a session — previously conversations were never persisted (and the history list stayed empty) until…
- **Configuration page could wipe MCP servers** — `mcp.servers` was missing from the settings payload, so the page loaded it empty and Save overwrote real server configs with []…
- **Derived values written to settings** — The model-capabilities payload was being saved back as a junk `adoCode.modelCapabilities` setting — derived values are excluded from saves

## [0.5.5] - 2026-08-06

### Features

- **Git worktree isolation for concurrent agents** — Each agent run now gets its own isolated git worktree under `.ado-code/worktrees/`, preventing branch conflicts and file corruption when…
- **Multi-agent output panels** — Multiple agent runs now display as separate collapsible panels in the chat, each with independent streaming output and a close button…
- **Agent summary in formatted webview panel** — Agent completion summaries now open in a styled HTML panel (like WorkItemDetailPanel) instead of a raw markdown preview, with metadata…
- **Status Panel context menus** — Right-click actions on Status Panel items
- **Work item selection highlighting** — Selected work items now show a green check icon with "◀ active" badge in the tree view
- **Deselect Work Item** — New command to release the active work item selection (title bar button + context menu)
- **AI choice prompt detection** — When the AI asks the user to choose between options, the response is parsed and displayed as an inline confirmation card with clickable…
- **Reassign Work Item** — Fixed missing context menu entry for reassigning work items to other team members

### Improvements

- **Universal ADO API fallback** — All ADO REST API calls now try the GA version (7.1) first and automatically retry with preview (7.1-preview.4) if the org hasn't rolled out…
- **Status Panel live updates** — Memory changes now trigger debounced tree refreshes; configuration changes are categorized to avoid unnecessary agent re-detection
- **Worktree listing in Status Panel** — Active agent worktrees are displayed in the Status Panel with branch names and run IDs

### Bug Fixes

- **Reassign Work Item 400 error** — Fixed API version mismatch — PATCH endpoint now uses correct preview version with automatic fallback
- **Single agent output overwrite** — Fixed issue where only one agent's output was visible when multiple agents ran concurrently
- **Agent summary cluttering chat** — Agent summaries no longer append to chat panel output — they open in a dedicated editor panel

## [0.5.4] - 2026-08-05

### Bug Fixes

- **Slash commands no longer leave chat stuck at "Thinking"**
- **Task detail panel persists across panel collapse/reopen**
- **Task detail panel no longer blocks chat input** — Detail panel is now constrained to 40vh max with internal scrolling, so the chat input is always accessible
- **Removed dead AgentBar dropdown** — The agent selection dropdown in the chat was never wired to anything — agent delegation happens via context menu or `/delegate` command
- **Secondary side bar support** — Fixed container ID conflict and registered views so all panels (Chat, Work Items, Status) can be moved to the secondary side bar via…
- **STATUS tree shows agents after load** — Agent list in the Status tree view now appears correctly — the tree refreshes after async agent detection completes
- **Pi agent now receives project context** — Agent delegation injects AGENTS.md content into the prompt, so Pi (which doesn't auto-read project files) understands the codebase structure
- **AGENTS.md generation prompt** — When opening a workspace without AGENTS.md, users are prompted to auto-generate it with detected build commands, project structure…
- **Git init prompt** — Non-git workspaces are detected on load and users are offered to run `git init` with confirmation
- **Empty workspace project scaffolding** — Empty directories trigger a setup wizard — choose project type (Node.js TS/JS, Python, PHP/Laravel, .NET C#), enter name…
- **Workspace-to-ADO project binding** — `.ado-code/config.json` ties the workspace to a specific ADO project/org

### Improvements

- **"Start Task" confirmation and detail panel** — Clicking the rocket icon on a work item now shows an in-chat confirmation card, changes ADO status to "Active", creates a feature branch…
- **In-chat confirmation cards**
- **MCP Servers in Configuration page**
- **Hierarchical work item trees** — My Work Items and Unassigned Work Items now show parent-child hierarchy (Epic → Feature → User Story → Task) matching the ADO structure…
- **Full detail view in editor** — Right-click any work item → "Show Full Details" opens a formatted detail panel in the main editor area with metadata, description…
- **Slash command descriptions now include parameter hints**
- **Status panel only shows installed agents** — Non-installed agents are hidden from the Status tree view — no more "not found" clutter
- **AGENTS.md check on new sessions** — Opening a workspace without AGENTS.md prompts the user to generate it with detected project structure

## [0.5.1] - 2026-08-04

### Features

- **Terminal command permission prompts**: Non-allowlisted terminal commands now show a 4-option permission dialog instead of a hard block
  - **Allow Once** — execute this command one time
  - **Allow for Session** — execute and auto-approve this exact command for the rest of the session
  - **Allow Permanently** — execute and add the command to the permanent allow list (`adoCode.act.terminalAllowlist`)
  - **Deny**
  - Works in both `act` and `inline` modes
  - Session approvals reset when chat is cleared or a new session starts

## [0.5.2] - 2026-08-04

### Improvements

- **Tag/chip input for array settings** — Configuration page array fields (Terminal allowlist, Enabled agents) now use a visual tag/chip interface…

### Bug Fixes

- **Secondary Side Bar support** — Added `secondaryBar` views container registration so ADO Code views can be moved to the Secondary Side Bar via right-click context menu

## [0.5.0] - 2026-08-04

### Features

- **Vision / Image Support**: Paste images directly into the chat — the AI assistant can now see and discuss screenshots, diagrams, error messages, and design references
  - Clipboard paste (Ctrl+V) captures images as base64 data URLs
  - Images are sent as native content blocks to Anthropic and OpenAI APIs
  - Anthropic: image blocks passed through to the Messages API natively
  - OpenAI: converted to `image_url` format for Chat Completions API
  - Session persistence stores text summaries when images are present

## [0.4.3] - 2026-08-04

### Bug Fixes

- **Blank webview fix**: Consolidated `acquireVsCodeApi()` into a single shared module (`src/webview-ui/src/vscode.ts`) — multiple calls crashed React before mount
- Session initialization wrapped in try-catch so migration errors never break the webview

## [0.4.2] - 2026-08-04

### Session History

- **Per-project sessions**: Chat sessions are now stored per workspace + ADO project, with the ability to switch between older sessions
- **Session dropdown**: New 🕐 session history dropdown in the chat header — click to switch, double-click to rename, × to delete
- **New Session button**: Create a fresh session from the dropdown
- **Auto-naming**: Sessions are automatically named from the first user message
- **Legacy migration**: Existing single-conversation history is auto-migrated to the session format

### In-webview Configuration Page

- **Full settings page**: New Configuration page accessible from the kebab menu (⋯ → Configuration) — shows all 9 setting categories …
- **Live editing**: Toggle booleans, select enums, edit strings — all changes apply to VS Code settings on save
- **Replaces VS Code settings**: "Configuration..." now opens the in-webview page instead of VS Code settings UI

### Slash Command Parameters

- Slash command autocomplete dropdown now shows usage/parameters for commands that accept them (e.g. `/status <state>`, `/mode [mode]`, `/assign <person>`)

### Refresh to Kebab Menu

- Moved "Refresh Work Items" button from the chat header into the kebab menu (⋯) to reduce header clutter
- ProjectSwitcher's own refresh button unchanged (refreshes the project list, not work items)

### New Settings

- `adoCode.sessions.maxPerProject`: Maximum number of sessions to keep per project (default: 20, auto-pruned)

### Bug Fixes

- Fixed `persistConversation` test — updated to match new session-based persistence format

## [0.4.1] - 2026-08-04

### Feature Visibility Overhaul

- **Output Channel**: New "ADO Code" output channel for structured logging across all subsystems (MCP, memory, checkpoints, context, agents)
- **Status Panel**: New sidebar tree view showing mode, memory counts, MCP servers, and agent status at a glance
- **Memory Browser**: Commands to view, edit, and clear user/workspace memory from the command palette (Show Memory, Edit Memory Entry, Clear All Memory, Show Workspace Memory)
- **Token Usage Indicator**: Status bar item showing approximate token usage during conversations
- **Stop Button**: Red stop button appears during LLM streaming to cancel generation mid-response
- **Set Mode Command**: QuickPick to switch between Inline/Plan/Act modes from command palette
- **Checkpoint Browser**: List and restore checkpoints from command palette (List Checkpoints)

### MCP Integration Fix

- MCP servers now connect on extension activation (was silently broken — `connectAll()` was never called)

### Bug Fixes

- Fixed slash command autocomplete: arrow-key navigation now correctly selects the highlighted command (was a stale closure bug in `handleKeyDown` dependency array)

### Cleanup

- Removed unused extended modes (code/architect/ask/debug) — only inline/plan/act are wired

## [0.4.0] - 2026-08-04

### Agent Reference Files

- AGENTS.md: universal agent reference for coding assistants (Claude Code, Codex, Cursor, etc.)
- Cross-platform structure analysis script (Node.js, runs on Windows/Linux/macOS)
- Pre-commit quality gate script (compile + test)
- 6 playbooks for common tasks (add tool, adapter, message, MCP, memory guides)

### User Memory System

- Persistent per-user preferences stored in VS Code globalState
- Categories: preference, instruction, correction, context
- set_memory tool for AI to learn from conversations
- Auto-injected into LLM system prompt

### Workspace Memory System

- Per-project conventions stored in .ado-code/memory/*.md
- Files: conventions, architecture, gotchas, custom
- read/write/list_workspace_memory tools for LLM
- Git-committable for team sharing

### Slash Commands

- 12 commands: /status, /comment, /pick, /assign, /clear, /mode, /undo, /help, /delegate, /resume, /remember, /forget
- Autocomplete dropdown when typing /
- Keyboard navigation (arrows + enter)

### UI Improvements

- Direct mode selection: click Chat/Plan/Act directly (no cycling)
- Refresh icon in chat header for quick work item refresh
- Hover effects on mode toggle options

### Quality Gates

- husky + lint-staged pre-commit hooks
- Auto-run compile + test before every commit

## [0.3.0] - 2026-08-04

### Checkpoint System

- File-level checkpoint service for saving/restoring workspace files before AI edits
- Auto-save checkpoint before mutating tool calls
- restore_checkpoint tool for the LLM to undo file changes

### MCP Integration

- MCP client for connecting to external tool servers via JSON-RPC over stdio
- McpManager for managing multiple server connections
- Tools exposed as mcp__<server>__<tool> in the agentic loop

### ADO API Version Update

- Updated all Azure DevOps REST API calls to version 7.1 GA
- Comments API updated from 6.0 to 7.1-preview.4

## [0.2.0] - 2026-08-04

### Phase 1: Core Architecture

- BaseTool abstract class with typed parameters, execution lifecycle, and error handling
- BaseProvider interface for LLM provider abstraction
- ToolRegistry for dynamic tool registration and discovery
- ContextProxy for workspace-safe context passing

### Phase 2: Tool Implementations

- ReadTool, SearchTool, EditTool, ExecuteTool, ListTool

### Phase 2: Provider Abstraction

- OpenAI v2 provider with streaming support
- Anthropic v2 provider with streaming support

### Phase 2: Modes System

- Code mode: streaming with inline tool calls
- Architect mode: read-only tools, produces implementation plans
- Ask mode: conversational, no tools
- Debug mode: diagnostic-focused with verbose output

### Phase 2: Context Management

- Token counter, context manager, condenser

### Phase 2: UI Components

- Button, Tooltip, Dialog, Toggle, Badge, Card component library
- Enhanced MessageList with markdown rendering and tool call cards
- Enhanced InputBar with @file mention, image paste, and message history

### Security

- Workspace boundary validation on all file tools
- Platform-safe process kill for WSL/Windows environments

## [0.1.3] - 2026-07-15

### Added

- Agent delegation with Claude, Codex, OpenCode, Hermes, and other agents
- Task detail review and clarification workflow
- Consent card for inline-mode mutating tools
- Project switcher in chat header
- CHANGELOG auto-update on task completion
