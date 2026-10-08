# Changelog

All notable changes to ADO Code will be documented in this file.
## [Unreleased]

## [0.7.2] - 2026-10-08

### Fixed

- **`create_work_item` no longer reports a phantom "cancelled by user" when the AI batches draft creation** — Auto-approved tool calls of one agentic iteration run *concurrently*, but the draft editor tab and its confirmation card are single-slot:…
- **A message typed while a tool is running now interrupts that tool instead of waiting for it** — Steer-mode text was only drained at the *top of the next agentic iteration*, so a blocking `run_terminal_command` (up to its 2-minute…
- **A long tool command no longer pushes the approval card's buttons (and the input bar) off-screen** — The inline consent card rendered `run_terminal_command`'s full command text verbatim inside a rigid…
- **Agent worktree creation is now Windows-safe** — `GitService.createWorktree` created its base directory by spawning the `mkdir` binary with -p…
- **Headless `vscode` stub: `ThemeIcon` now retains its `ThemeColor`** — The stub’s `ThemeIcon` constructor ignored its second argument, so `icon.color` was always `undefined` and the three…
- **Moving the chat into the Editor Area no longer drops an open in-chat prompt** — Tool-consent and confirmation popups are rendered by whichever webview hosts the conversation
- **Webview unit suites are green again — the `ChatViewProvider` tests were failing on an incomplete mock** — `syncTodoSession()`, the session rename/remove handlers and `createNewSession()` all dereference services.todos…
- **Webview tree and mermaid suites are green again — the headless `vscode` stub now models `TreeItem`, `ThemeIcon` and `MarkdownString` for real** — `todoTreeProvider`, `worktreesTreeProvider` and `mermaid` build real tree nodes, but the stub's `TreeItem` was a permissive proxy whose…
- **`createNewSession()` can no longer mint two sessions with the same id** — Session ids came straight from `new Date().toISOString()` (millisecond resolution), so a rapid "New Session"…
- **`npm test` no longer dies before it starts when the shell already lives inside Electron** — `@vscode/test-electron` launches the downloaded VS Code by copying the parent environment verbatim (`Object.assign({}, process.env, ...)`)…
- **The Electron harness's Windows temp-directory cleanup no longer stalls or leaks** — `cleanTempDir()` ran `git gc --prune=now` before deleting each temp directory "to release Git locks"…
- **The consent-gate suite no longer runs real `git` mutations against the repository** — The `ToolExecutor · 0.6.5 consent & push gates` tests execute approved commands for real via `execFile` with `cwd` = workspaceFolders[0]…

### Maintenance

- **Removed two redundant config tests** — `configCanonicalKeys.test.ts` re-asserted two invariants already covered by `configSchema.test.ts` (every catalog key is a canonical…
- **Licensing metadata added — the project is now MIT** — It was publicly distributed (GitHub plus Marketplace `.vsix`) with no `LICENSE`, no `package.json` `"license"` field and no README licence…
- **Removed `src/llm/providers/BaseProvider.ts`** — Its two strict-mode tool-schema helpers (`convertToolsForOpenAI`, `convertToolSchemaForOpenAI`) were verbatim Roo-Code code with no…
- **Reworded the last Roo-Code attribution comments** — the three file headers in `src/llm/tools/types.ts`, `src/llm/modes.ts` and src/llm/prompts/system.ts…
- **Regenerated the tracked webview bundle** (`webview-ui-dist/webview.js`, committed build output) — so the artifact matches the reworded CSS
- The one live export of that module, the `ContentBlockText` / `ContentBlockImage` / `ContentBlockParam` types, moved to `src/llm/types.ts`
- **Packaging: `.github/**` and `.husky/**` are now excluded from the `.vsix`** — CI workflow definitions and Husky git hooks were shipping inside the published package
- **Open VSX publishing is now scripted — `npm run publish:open-vsx`** — `vsce` cannot publish to Eclipse Open VSX: it is a separate registry with its own CLI (`ovsx`), account and token
- **The marketplace icon is a real PNG again** — `resources/icon.png` was a JPEG (JFIF) renamed to `.png` — 428 KB of mislabelled image that VS Code and Open VSX both advertise as a PNG
## [0.7.1] - 2026-10-05

### Performance

- **Activation no longer loads the whole extension graph, or builds services it may never use** — Three changes, each measured with the interleaved A/B harness (`node scripts/bench-ab.js <entryA> <entryB> --activate`)

### Bug Fixes

- **A chat could mint a brand-new session id on every request** — Chat sessions were persisted under a key that folded in the *currently active* ADO project (adoCode.sessions:<folder>:<project>…
- **Outbound User-Agent reported a version that never shipped** — `EXTENSION_VERSION` (`src/shared/version.ts`) had drifted from `package.json`, so every LLM request on 0.7.0 still announced…
- **Version drift is now blocked in CI, not just by local hooks** — `.github/workflows/version-check.yml` runs `check:version` as a status check on every PR and on pushes to main…
## [0.7.0] - 2026-10-01

### New Features

- **Queue vs. steer for mid-run input** (`adoCode.chat.inputWhileBusy`, default `steer`) — choose what happens when you type while the AI is working
- **AI delegation suggestions** (`adoCode.chat.suggestDelegation`, default on) — the assistant can recommend handing a coding task to an installed external agent, and the chat renders a compact suggestion card…
- **Chat density modes** (`adoCode.chat.density`, default `comfortable`) — an explicit three-way control over the chat's per-turn detail
- **`View Archived Goals` affordance in the To-do view** — a toolbar toggle (`$(archive)` / `$(checklist)`) switches the view between the live list and a read-only history of the active session's…

### Improvements

- **Steering is non-destructive** — steering a running turn no longer aborts it
- **Chat-area declutter — readability first** — long, tool-heavy turns no longer bury the answer under execution chrome
- **Session-scoped To-do view** — the view now renders only the **active chat session's** goal and steps, so switching sessions resets the panel to that session's list…
- **Superseded goals are archived, not discarded** — when a new goal & to-do list is created for a session after the previous goal was fully completed…
- **Archive lifecycle** — deleting a chat session removes its archive too (`removeSession`); the plain To-do `Clear` intentionally keeps the archive…
- **One error banner, everywhere** — the Configuration page carried its own error banner *and* auto-dismiss timer — a second implementation of the chat view’s banner…

### Fixes

- **Switching sessions no longer aborts a running turn** — picking another session (the history dropdown, **New Session** or `/resume`) used to stop the in-flight response outright…
- **Warned before a background run is stopped** — sending a message in a *different* session while one is still generating is the only remaining way to kill it (a single LLM turn runs at…
- **`/remember` now actually remembers** — it previously wrote to a workspace-keyed notes store nothing ever read, so remembered notes never reached the model
- **Session name updates as soon as the topic is known** — a session created via **New Session** kept that placeholder label in the header and the history dropdown until you switched to another…
- **Running badge in the session list** — a session that is still generating — including one still working in the background after you switched away…
- **Enter works mid-turn, multi-line input stays readable, history stops auto-jumping** — three chat-view UX fixes
- **Configuration page surfaces every contributed setting** — six settings declared in `package.json` (and honored by the extension) were missing from the Configuration UI…
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
- **Configuration page split into focused modules** — `ConfigurationPage.tsx` had grown to ~1250 lines mixing five concerns (settings catalog, collection inputs, model widgets, page shell…
- **Data-driven setting rendering; derived Advanced count** — the Configuration page's ~65-line setting.type === … ?
- **`saveConfig` payload is validated; the settings map is typed** — the `saveConfig` handler wrote every key the page posted straight through updateSettingRespectingScope…
- **One source for the webview ↔ host message contract** — the message unions and the shared domain types (`WebviewToExtensionMessage`, `ExtensionToWebviewMessage`, `ExtensionConfig`, Session…
- **Configuration page styles are co-located** — ~700 lines of `.config-*` rules moved out of the global `styles/app.css` into `src/webview-ui/src/components/config/styles.css` (mirroring…
- **Configuration contract hardening (R-series)** — three latent couplings in the Configuration UI were removed
## [0.6.7] - 2026-09-30

### New Features

- **Session To-do list and goal** (`To-do` view + `set_goal` / `update_todo_list` tools)

### Improvements

- **Workspace memory entries are readable and openable from the status panel**
- **Thinking & Tools record now survives a session reload**
- **Tool cards: completed calls never render as "running"**
- **Reasoning can no longer be prepended to an answer**
- **A streamed reasoning delta can no longer absorb the start of an answer** — reasoning that arrives after answer text has started now opens a new reasoning block instead of appending to the block that preceded…
- **Live turn header no longer repeats the block label** — when reasoning is already on screen the activity headline reads "Reasoning…" / "Working…" instead of a second "Thinking…" above…
- **Tests** — new suite for turn-trace persistence (capping, re-persist stability, restore round-trip, repeated-answer pairing)
## [0.6.6] - 2026-09-26

### Improvements

- **Per-org PAT support** — `adoCode.organizations` entries now accept an optional `pat?` field — a per-organization Personal Access Token that overrides the global…
- **Windows-safe temp-directory cleanup (`cleanTempDir`)** — New test utility `src/test/suite/utils/cleanTempDir.ts` replaces bare `fs.rmSync` calls in four test suites (`gitService`, mergeCleanup…
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

- **Every LLM request carries a user-agent** — All provider calls (OpenAI-compatible and Anthropic: chat, tool calls, native token counts…
- **"Review Task Detail" is now an AI review** — Right-click a work item → Review Task Detail no longer only opens the detail — it binds the item to the chat and hands it to the AI…
- **One work item per session** — Sessions now remember which ADO work items they processed and show them as #chips in the session-history dropdown
- **Work-item hover shows the ID** — Work-item tree tooltips now open with `#<id> · <title>` in addition to the existing type/state/assignment details
- **Command palette refreshed** — Every contributed command now carries the ADO Code category and clearer titles ("Change Work Item State", "Reconnect MCP Server"…
- **Auto-approve harmless commands runs instantly** — With `adoCode.consent.harmlessAutoApprove` on, read-only terminal commands (git status/diff/log, npm test, ls, grep…
- **Iteration budget defaults to 100** — `adoCode.act.toolBudget` (Iteration budget) now defaults to 100 with the recommendation "100+"…
- **Model pickers are dropdowns in Configuration → Advanced** — Opening the Configuration page auto-fetches the provider's model list when LLM credentials are saved, so the main model field…
- **Token counting includes tool + image content** — The local heuristic counter now charges for every block actually passed to the LLM — tool-call argument JSON on assistant messages…
- **YOLO still asks before pushing** — Pushing code to the remote repository — the `push_worktree` tool OR a terminal `git push` — now requires approval even in YOLO mode
## [0.6.4] - 2026-09-08

### Improvements

- **Maxed-out turns conclude in the chat instead of erroring** — When a turn uses its full iteration budget while still asking for tools, the loop previously threw and the user saw a bare error banner…
- **Iteration counts stay model round-trips, not tool calls** — The budget (`adoCode.act.toolBudget`, surfaced as "Iteration budget") is consumed per model round-trip…
- **Structure-first, read-lazy project study** — To save context and turns when exploring an unfamiliar codebase, the model is now guided to orient on directory structure and doc files…
- **AGENTS.md keeps itself current** — AGENTS.md is now a managed file kept in sync with the repository understanding (`.ado-code/understanding/`) instead of a one-shot template
- **Mixed-batch tool calls stay parallel** — When a model turn issues several tool calls and only some of them need your approval, the consent-free calls (reads…
- **Batch work-item reads** — `get_work_item` now accepts an `ids` array — fetch several work items in ONE call (details batch-fetched…
- **Batch terminal commands** — `run_terminal_command` now accepts a `commands` array — run several commands in ONE call (each still checked for shell operators and…
- **Wizards take over the sidebar** — Opening the Configuration page, the project-creation wizard, or the first-run setup screen now collapses the sibling views (Work Items /…
- **"Configuration…" opens the in-app Configuration page** — The chat kebab's Configuration… item previously opened VS Code's native settings — it now opens the in-webview Configuration page (the same…
- **Agentic turns leave an ordered record that stays visible after the loop ends** — Reasoning used to accumulate into one run-on block above every tool card, and when the turn completed the work product vanished…
- **Chat splits into two sides** — AI answers stay on the left; your messages move to the right as a compact bubble — button-colored…
- **No more (AI)/(You) label circles** — The little avatar circles carrying the speaker label next to each message are removed
- **Chat turns always conclude** — A turn that ends right after tool work with no closing text (or a provider returning an empty final) previously vanished from the thread…
- **Delegated runs keep the chat alive and conclude in place** — The "Delegated to …" message is now ONE evolving run card in the thread: the host rewrites it as the run progresses (throttled)…
- **Chat sessions no longer interfere with each other** — A chat turn is now bound to the session that started it — it reads/writes only that session's buffer and only posts progress while…
- **Streamed answers are buffered and flushed safely** — Partial replies stream in the live bubble and materialize as a single normal message at completion…
- **Every timeout shows a countdown with a named post-timeout action** — Consent cards (auto-approve for harmless commands, auto-deny for everything else) and in-chat confirmation prompts (auto-cancel) now render…
- **Prompt timeouts pause while you're away** — A pending consent/confirmation card no longer ticks down while you're not looking at it
- **Top-of-panel error banners auto-dismiss** — Host errors (ADO/LLM fetch and save failures) shown in the banner at the top of the chat panel now disappear on their own after 8 seconds…
- **Agent detection matches what your terminal can run** — Detection previously probed ONE executable shape per platform — on Windows it looked only for the npm `claude.cmd` shim…

### Fixed

- **Configuration-page PAT/org/project saves now take effect** — Saving from the in-app Configuration page previously updated the settings, but `getActiveOrg` resolved the active org/project…
## [0.6.3] - 2026-08-28

### Improvements

- **New Project wizard creates projects anywhere** — The wizard previously always failed with "No target path specified" — the webview sent an empty target folder for the host to resolve…
- **Empty-workspace prompt opens the full wizard** — The "Create New Project" offer shown in an empty folder used an old limited inline flow (6 templates, no options, no review)…
- **Wizard template defaults apply even when you skip the options step** — Picking a template now pre-fills its option defaults (README/.gitignore/LICENSE for Empty, ESLint/Prettier/Jest for Node…
- **Wizard git branch name is honored** — The "Initial Branch Name" field was collected but ignored — `git init` used whatever your machine's default branch happens to be
- **ADO integration creates the work item** — The ADO Integration step collected work-item type and area path but did nothing with them
- **Wizard errors are visible again** — Create failures used the global error banner, which sits behind the wizard's full-screen overlay…
- **Scaffolded projects are more solid** — Laravel scaffolds now include the missing `bootstrap/app.php` (artisan couldn't run) and emit valid PHP namespaces…
- **Project-name validation** — Empty or path-traversing project names are rejected up front with a clear message instead of writing outside the target folder

### Fixed

- **24 new tests covering every project type** — Each of the 9 templates (Node TS/JS, Python, PHP Laravel/plain, .NET Web API/Console, React, Next.js, Empty) is now exercised end-to-end…
## [0.6.2] - 2026-08-25

### Improvements

- **Images inside work items are now retrieved and displayed** — Rich-text fields (Description, Acceptance Criteria, Repro Steps, System Info) and discussion comments can contain `<img>` tags pointing…
- **Work Items view shows assignment at a glance** — Each item is now marked with an assignment cue — a **blue person** = assigned to you, an **orange person** = assigned to someone else…

### Fixed

- **Numbered task lists are now posted to ADO** — The generate-tasks flow only parsed the model's ` ```json  fence — when the model answered with a plain numbered list ("1
- **Numbered/bulleted sub-items inside task descriptions no longer lost** — Task descriptions and acceptance criteria were truncated to their first line when the review file was parsed back (the field regex stopped…
- **Changelog comments posted to ADO are now cleanly formatted** — The completion-flow comment relied on single newlines, which ADO's markdown engine collapses (a soft break needs two trailing spaces)…
- **Created work items render their descriptions correctly in ADO** — `markdownToHtml` (which converts task descriptions/acceptance criteria into the HTML ADO expects) wrapped list items with a greedy regex…
## [0.6.1] - 2026-08-23

### Improvements

- **Cached repository + work-item understanding** — ADO Code now keeps a durable, fingerprinted understanding of the active repository and the selected ADO work item…
- **DeepSeek Harness as a delegation agent** — `dsh` is now a first-class external agent — detected via `dsh --version`, delegatable from chat, `/delegate`, the work-item context menu…
- **Proper tree structure for the Work Items tree** — The tree now renders the real ADO hierarchy instead of flat roots
- **Merged Work Items view with mode toggle** — My Work Items, All Work Items, and Unassigned Work Items are now ONE tree view ("Work Items") with a **visible mode header row** at the top…
- **Parallel tool execution (pi parity)** — Independent tool calls in a single model turn now run concurrently instead of one-after-another…
- **Per-file mutation queue** — Parallel batches that edit the SAME file are serialized (read-modify-write can't interleave)…
- **Truncated-response guard** — When the model hits its output token limit (`length`/`max_tokens`), tool calls are NOT executed — arguments may be truncated mid-JSON…
- **Batched edits** — `edit_file` now accepts an `edits[]` array for several disjoint changes to the same file in one call (applied in order…
- **`search_files` grep tool is now real** — Previously advertised in the prompt but unimplemented, it now greps the workspace with a JS regex — `path:line` hits…
- **`execute_skill` tool works again** — The system prompt told the model to call `execute_skill`, but the executor couldn't run it — every attempt errored as "unknown tool"
- **External skill registries** — Browse and install community skills from remote TSV registries (`slug<TAB>url<TAB>description`)
- **Smarter prompt guidance** — The system prompt now tells the model to issue independent tool calls in the same request (so the parallel loop is actually used) and…
- **Live agent progress in the editor** — Agent delegation progress can now be moved to the editor area
- **Parent delegation completes child items** — Delegating a parent work item (Story, Feature, Epic) now covers its **whole descendant subtree** — children, grandchildren, and beyond…
- **Main-model choice offers (zero extra cost)** — When the model's answer ends by offering you a choice ("Should I … or …?"), it now appends a fenced ` ```choice  block with 2–6 short…
- **Active editor context auto-injected per turn** — The file you're editing is now automatically included in each chat turn's context, so the assistant sees the code you're actually working…
- **Slimmer session persistence** — Sessions now persist only the last 25 complete user/assistant message pairs (plus the leading condensation/truncation marker) instead…
- **AGENTS.md honored in chat** — The chat system prompt now instructs the model to read and honor an `AGENTS.md` at the workspace root when present…
- **Iteration budget clarified** — `adoCode.act.toolBudget` is now surfaced as "Iteration budget" (each iteration is one model round-trip that may run several tool calls…
- **Provider-native token counting refined** — Native counting is now forced ON for Anthropic (its `/count_tokens` endpoint is free) and stays opt-in for OpenAI-compatible gateways via…

### Fixed

- **Tolerant `System.Parent` parsing** — Some ADO orgs serialize the parent link as a bare integer instead of `{ id }` — parent ids are now parsed from either shape (object…
- **Conversation summaries silently dropped on Anthropic** — Condensation summaries were prepended as mid-array **system** messages — the Anthropic providers hoist only the FIRST system message…
- **Laravel scaffold generated broken PHP** — The `artisan` and `routes/web.php` templates used `\C`/`\$` escapes that JavaScript template literals silently collapse…
- **Security: dompurify bumped to 3.4.14** — in the webview bundle (fixes the flagged moderate vulnerability)
- **dsh delegation for existing users** — Users whose stored `adoCode.agents.enabled` predates DeepSeek Harness (the previous default list) silently lost dsh…

### Changed

- **Tree diagnostics in Output → ADO Code** — The refresh now logs `Work item hierarchy: N items (M base, K context)`, a one-time `System.Parent raw sample: …` line (shows…
- **Single tool implementation path** — Removed the legacy Roo-Code-style layer (`BaseTool`, `ToolRegistry`, the `definitions/` schemas, and the five per-tool classes)…
- **Docs updated** — `docs/playbooks/add-tool.md` rewritten for the single-path architecture, `docs/chat-token-optimization.md` refreshed with the new…
- **Lint-clean + dead code removed** — All 37 ESLint errors fixed (inline `require()`s moved to top-level imports, regex character-class escapes corrected…
- **Test runner env hook** — `ADO_CODE_TEST_EXTRA_ARGS` lets you pass extra VS Code launch args for sandboxed/container environments (e.g
## [0.5.9] - 2026-08-21

### Improvements

- **Live thinking + tool progress in chat** — While the AI works, the chat window now streams its reasoning into a 💭 Thinking block and shows every tool call as a live card…
- **Permanent tool-call record** — When the turn finishes, the tool cards are merged into the assistant message above the answer as collapsible blocks…
- **Hide tool calls in chat** — New `adoCode.chat.showToolCalls` setting (default on, in Configuration → Chat) hides the tool cards — tools still run normally…
- **Show AI thinking is now enforced** — The existing `adoCode.chat.showThinking` toggle (Configuration → Chat) previously had no effect — thinking text was always displayed
- **Wildcard permissions** — Two ways to grant broader permission "to a certain extent"
- **Wildcard-aware session approvals** — "Allow for Session" choices also honor patterns, so approving `git *` once covers every git command for the rest of the session
- **Token consumption optimization for the agentic loop** — tool results are capped to a token budget (`read_file` defaults to a bounded window, terminal/work-item/list output is trimmed head+tail)…
- **Provider-native token counting** — the token status bar now uses the provider's own tokenizer (Anthropic `/v1/messages/count_tokens`, free…
- **Accurate token budget** — context truncation/condensing and the status bar now account for the system prompt + tool schemas that ride along with every request…

### Changed

- **Reorganized Configuration UI** — Settings are now grouped into navigable sidebar categories — **Connection** (Azure DevOps + LLM Provider), **AI & Modes** (Mode, Act Mode…
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

- **Task draft editor** — The `create_work_item` LLM tool now opens an editable markdown tab before creating work items in ADO — review, edit fields (title…
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
- **Agent run history** — Recent Runs section in the Status Panel shows last 10 completed runs with status icons, timestamps, and context menu (View Summary…
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
- **Merge-flow guardrails round 2** — `commit_worktree` now refuses to commit a run whose verification FAILED unless the assistant explicitly passes `allowFailed` (after…
- **Child task delegation** — When delegating a work item to an agent (via `delegate_to_agent` tool or `/delegate` slash command)…
- **Clean Up After Merge** — New context-menu action on the Worktrees view and auto-offer after a merged PR — removes the run's worktree and deletes its branch…
- **Capability overrides** — `adoCode.llm.capabilityOverrides` (array of { model, vision?, tools?
- **Live model capabilities** — Detection is now three layers — user override > live gateway data (OpenRouter architecture.input_modalities…
- Removed redundant "Select Work Item" context menu entry (was duplicated across two menu groups)

### Bug Fixes

- **Choice-card answers went stale** — Clicking an option on an AI-posed question posted `sendMessage`, which the host silently dropped…
- **"spawn git ENOENT" on legacy worktrees** — Commit & Push / Clean Up After Merge failed on worktrees created by older versions (`run-run-…` directories)…
- **Pre-commit hook git env var pollution** — The pre-commit hook now clears `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_WORK_TREE`, and other git env vars so the test suite (which shells out…
## [0.5.6] - 2026-08-07

### Features

- **Capability overrides** — You know your model best — `adoCode.llm.capabilityOverrides` (array of { model, vision?, tools?
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
- **Model list retrieval in Configuration** — Once an API URL and API Key are entered, a "Fetch Models" button lists models from the endpoint (OpenAI `/models` or Anthropic…
- **`.ado-code` auto-ignore** — The workspace data directory (memory, checkpoints, agent runs) is now offered to be added to `.gitignore` and `.dockerignore` when missing…
- **AI merge flow** — The assistant can now execute the whole merge flow for a finished agent run itself via three new tools…
- **Worktree merge guardrails** — `delegate()` refuses a second concurrent run on the same work item (both would share a branch) and warns when an existing branch is behind…
- **Working indicator** — A status-bar spinner (`$(sync~spin) Working…`) shows while any LLM turn or agent run is in flight — host-side…
- **Background processing survives view changes** — Closing/hiding the chat panel no longer force-denies pending consent mid-turn — the LLM loop keeps running host-side…
- **AI choice detection (LLM-assisted)** — Responses that ask a question without numbered options (e.g
- **Sessions auto-create** — The first chat message now creates a session (named from the message) — no more "No sessions yet" for users who never clicked New Session…
- **Full Configuration page coverage** — Every contributed setting now round-trips through the page — including a structured **Organizations** editor (name/URL/project)…

### Improvements

- **Branch names use the ADO subject** — Delegated agent worktree branches are slugged from the work item title (e.g
- **Tree view title bars cleaned up** — The cramped title-bar strip no longer holds Refresh/Deselect buttons — Deselect Work Item moved into the row context menu (shown only while…
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

- **Slash commands no longer leave chat stuck at "Thinking"** — `/comment`, `/status`, `/assign`, `/pick`, `/mode`, `/undo`, and `/help` now clear the loading spinner after execution
- **Task detail panel persists across panel collapse/reopen** — The selected work item's detail panel now survives VS Code panel hide/show cycles via webview state persistence and host-side re-fetch
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
- **In-chat confirmation cards** — All user confirmations and selections (task start, uncommitted changes, underspecified task, mode switch, session resume, push/PR…
- **MCP Servers in Configuration page** — New "MCP Servers" section in the Configuration page — add, edit, and remove Model Context Protocol server connections (name, command, args…
- **Hierarchical work item trees** — My Work Items and Unassigned Work Items now show parent-child hierarchy (Epic → Feature → User Story → Task) matching the ADO structure…
- **Full detail view in editor** — Right-click any work item → "Show Full Details" opens a formatted detail panel in the main editor area with metadata, description…
- **Slash command descriptions now include parameter hints** — `/assign`, `/status`, `/delegate` and others show what arguments they expect directly in the autocomplete dropdown
- **Status panel only shows installed agents** — Non-installed agents are hidden from the Status tree view — no more "not found" clutter
- **AGENTS.md check on new sessions** — Opening a workspace without AGENTS.md prompts the user to generate it with detected project structure
## [0.5.1] - 2026-08-04

### Features
- **Terminal command permission prompts**: Non-allowlisted terminal commands now show a 4-option permission dialog instead of a hard block
  - **Allow Once** — execute this command one time
  - **Allow for Session** — execute and auto-approve this exact command for the rest of the session
  - **Allow Permanently** — execute and add the command to the permanent allow list (`adoCode.act.terminalAllowlist`)
  - **Deny** — reject the command
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
- **Full settings page**: New Configuration page accessible from the kebab menu (⋯ → Configuration) — shows all 9 setting categories (ADO, LLM, Mode, Git, Changelog, Work Items, Act Mode, Sessions, Agents)
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
