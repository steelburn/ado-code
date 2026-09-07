# Changelog

All notable changes to ADO Code will be documented in this file.

## [0.6.4] - 2026-09-08

### Improvements
- **Maxed-out turns conclude in the chat instead of erroring**: When a turn uses its full iteration budget while still asking for tools, the loop previously threw and the user saw a bare error banner ("agentic loop exceeded N iterations"). It now ends with a real assistant conclusion in the chat: one extra, non-budgeted round-trip lets the model itself say that the iteration limit was reached and summarize what it accomplished and what remains; if that wrap-up call fails or returns nothing usable, a deterministic conclusion takes over. Tool calls in the wrap-up response are never executed, the conclusion is persisted into the session like any answer, and a stopped-by-limit turn no longer fires structured outcomes (plan-ready, task proposals) — the loop never got to a natural end. A limit-reached turn is flagged (`reachedIterationLimit`) so the cost log and host can tell it apart from a normal completion
- **Iteration counts stay model round-trips, not tool calls**: The budget (`adoCode.act.toolBudget`, surfaced as "Iteration budget") is consumed per model round-trip — one thinking iteration that issues 5 parallel tool calls costs ONE iteration, not five. That was already the loop's counting rule; it is now enforced end-to-end: the per-tool log line labels tools by the iteration they belong to (`[iteration 3/50]`), multi-tool batches log a single-iteration debug line, and regression tests pin the semantics (5 tools in one round-trip ⇒ 2 iterations total, limit messages report round-trips). The forced conclusion at the limit reports the same round-trip count, never the tool-call count
- **Structure-first, read-lazy project study**: To save context and turns when exploring an unfamiliar codebase, the model is now guided to orient on directory structure and doc files first (the cached Repository Understanding, `list_workspace`, README/AGENTS.md/docs/package.json), then drill into key files with narrow `read_file` ranges or `search_files` — avoiding bulk whole-file reads that stay in the conversation for the whole session. The guidance reaches the chat system prompt, the `read_file`/`list_workspace` tool descriptions, the delegated-agent handoff prompt, and the LLM repository-summary generator (which must lead with structure/docs so future sessions navigate without reading many files)
- **AGENTS.md keeps itself current**: AGENTS.md is now a managed file kept in sync with the repository understanding (`.ado-code/understanding/`) instead of a one-shot template. The generated sections — What This Is / Build & Test / Project Structure, plus Repository Understanding when the cache holds an LLM summary — sit between `<!-- ado-code:managed -->` markers, and the summary folds in as per-directory one-liners and a heading-demoted understanding block, so hand-written sections (Conventions, What NOT to Do, …) stay outside and survive every sync. AGENTS.md is generated when missing, and when the understanding shows it outdated (build/test/lint commands, project structure, or the refreshed summary changed) ADO Code offers an **in-place update** with the exact drift reasons, a diff **Preview**, and a decline memory keyed to the candidate — the offer only reappears when something actually changes. Legacy pre-marker files are migrated in place (title + your sections preserved); hand-authored files take a Preview-backed rewrite. **ADO Code: Refresh Repository Understanding** re-runs the sync check; the whole behaviour is gated by `adoCode.understanding.agentsMdSync` (default on). 30 new tests cover the markers, drift detection, decline suppression, migration, and the offer flow
- **Mixed-batch tool calls stay parallel**: When a model turn issues several tool calls and only some of them need your approval, the consent-free calls (reads, allowlisted commands) now execute concurrently while the approval-requiring calls still run one at a time — previously the whole batch serialized behind the first consent card, so read-only work waited on your click. Approval cards still never stack
- **Batch work-item reads**: `get_work_item` now accepts an `ids` array — fetch several work items in ONE call (details batch-fetched, discussion threads loaded in parallel, up to 20 ids) instead of N repeated calls and round-trips
- **Batch terminal commands**: `run_terminal_command` now accepts a `commands` array — run several commands in ONE call (each still checked for shell operators and the act-mode allowlist), outputs concatenated with `$ command` headers, a single consent card instead of one per command
- **Wizards take over the sidebar**: Opening the Configuration page, the project-creation wizard, or the first-run setup screen now collapses the sibling views (Work Items / Status / Worktrees) so the wizard gets the whole view container; the views are restored when the wizard closes, and views you'd hidden yourself stay hidden afterwards
- **"Configuration…" opens the in-app Configuration page**: The chat kebab's Configuration… item previously opened VS Code's native settings — it now opens the in-webview Configuration page (the same surface the ADO-not-configured banner offers), which also gets the full-width wizard treatment above
- **Agentic turns leave an ordered record that stays visible after the loop ends**: Reasoning used to accumulate into one run-on block above every tool card, and when the turn completed the work product vanished — the reasoning folded into a single collapsed “💭 Thinking” disclosure and the tool cards shrank to bare headers. Now each agentic iteration's reasoning streams as its OWN in-flow “Thinking” block, sitting exactly where the model produced it — directly above the tool batch it introduced — with tool calls appearing as running → completed cards right after their block, so thinking stays BETWEEN the tool calls in chronological order (both while the turn runs and in the finished message). When the loop ends the same record remains in the thread: every thinking block and tool card stays in place and open (blocks default open, collapsible; completed cards keep their details expanded), followed by the final answer. Over-long blocks are capped so a giant chain-of-thought can't bloat the message; streamed deltas still join their own block seamlessly. Reasoning remains transient — never persisted into session history
- **Chat splits into two sides**: AI answers stay on the left; your messages move to the right as a compact bubble — button-colored, hugging its content (capped at 85% of the panel) — so who said what reads at a glance
- **No more (AI)/(You) label circles**: The little avatar circles carrying the speaker label next to each message are removed. Every message already names its author in the header row (ADO Code / You), so the circles only duplicated that and ate a column of width on every row — the chat is denser without them
- **Chat turns always conclude**: A turn that ends right after tool work with no closing text (or a provider returning an empty final) previously vanished from the thread — the chat just stopped. The system prompt now requires every turn to end with a conclusion (including an explicit note when work is handed to a background agent), and the engine posts a deterministic concluding message when the model's final text is empty. Turn completion can no longer leave the thread silently dead.
- **Delegated runs keep the chat alive and conclude in place**: The "Delegated to …" message is now ONE evolving run card in the thread: the host rewrites it as the run progresses (throttled) and replaces it with the outcome (succeeded/failed/cancelled + summary + branch) when the run finishes — the chat no longer looks done while the agent panel is still busy. The outcome is also persisted into the delegating session's history (the stale "started" marker is replaced), so reloads show the conclusion, and auto-review streams into its own id'd bubble instead of fusing with whatever turn is streaming.
- **Chat sessions no longer interfere with each other**: A chat turn is now bound to the session that started it — it reads/writes only that session's buffer and only posts progress while that session is on screen. Switching chats, creating a new session, deleting a session, or clearing history stops an in-flight turn cleanly IN ITS OWN session (marker + persist), so its late chunks can never bleed into — or persist into — a different session's thread (previously a turn started in session A kept streaming into whatever session you switched to and its completion was saved to the wrong session).
- **Streamed answers are buffered and flushed safely**: Partial replies stream in the live bubble and materialize as a single normal message at completion; an error mid-stream flushes the partial text instead of dropping it, and the message protocol's stable bubble ids now support both replace (run cards) and append (streams) semantics.
- **Every timeout shows a countdown with a named post-timeout action**: Consent cards (auto-approve for harmless commands, auto-deny for everything else) and in-chat confirmation prompts (auto-cancel) now render a live countdown bar that says exactly what happens when it expires — e.g. "Auto-approving in 0:17" / "Auto-denying in 1:59" / "Auto-cancelling in 1:59". The host enforces every deadline (previously the harmless-command auto-approve lived only in the webview timer, so it stalled when the card wasn't mounted) and posts a `promptExpired` message when a prompt dies, so cards are cleared even when they were hidden behind the full-page Configuration page or project wizard at the moment of expiry — no more zombie "choose an option" dialogs that outlived the host-side wait or silently no-op on click after a detour and Back.
- **Prompt timeouts pause while you're away**: A pending consent/confirmation card no longer ticks down while you're not looking at it. Switching to another view (the chat panel hidden) or opening a full-page wizard (Configuration, project creation, first-run setup) freezes the countdown; when you come back (or press Back), the timer resumes with the exact time that was left and the card re-renders with the remaining countdown. The deadline is host-enforced, so a prompt can never expire mid-detour — and a card is re-posted after the detour rather than silently gone.
- **Top-of-panel error banners auto-dismiss**: Host errors (ADO/LLM fetch and save failures) shown in the banner at the top of the chat panel now disappear on their own after 8 seconds instead of lingering until the ✕ is clicked — the timer restarts whenever a new error replaces an old one, and manual dismiss still works. The Configuration page's error banner (which has no ✕ at all) follows the same timeout.
- **Agent detection matches what your terminal can run**: Detection previously probed ONE executable shape per platform — on Windows it looked only for the npm `claude.cmd` shim, so a native `claude.exe` install (the newer installer channel) was reported "not installed" even when it sat on PATH, and a CLI installed while VS Code was already running stayed invisible until a full reload because probe results were cached for the whole session. The registry now walks a fallback chain on Windows (`.cmd` → `.exe` → bare name) and records exactly which executable answered; delegation then spawns THAT SAME binary — the adapters previously hard-coded the bare name, so a detected npm shim could still fail to launch on native Windows with ENOENT, while an undetected `claude.exe` would have run fine. `.cmd` shims are executed through `cmd.exe` with verbatim cmd-grammar quoting so argument lists (including quoted prompts) reach the shim intact. Detection results also re-probe after 15 seconds instead of caching forever, so an agent installed or updated mid-session is picked up without reloading the window. New unit tests cover the candidate chain, the cmd quoting, and the re-probe window

### Fixed
- **Configuration-page PAT/org/project saves now take effect**: Saving from the in-app Configuration page previously updated the settings, but `getActiveOrg` resolved the active org/project from `workspaceState` FIRST and honored empty stored bindings — a binding left behind by a wizard save (`adoProject` stored as `''`) or an earlier org switch shadowed the settings forever, so after a save every ADO gate bailed with "configure organization, project and PAT first" (the setup wizard looked like the only working path because it also rewrites workspaceState). Non-empty settings now beat empty/stale bindings, wizard saves clear the binding instead of freezing `''` as the active project, org/project edits rebind workspaceState only when that field actually changed, a rejected key update no longer aborts the save loop silently (which could prevent `adoPat` from ever being written while the page flashed "✓ Saved"), and save failures surface on the page in an error banner instead. 5 regression tests cover the empty-binding fallback and save-sync paths

## [0.6.3] - 2026-08-28

### Improvements
- **New Project wizard creates projects anywhere**: The wizard previously always failed with "No target path specified" — the webview sent an empty target folder for the host to resolve and the host never did, so every create attempt aborted before touching disk. The host now resolves the destination itself: the open workspace folder (blank directories included) is used automatically, and you're asked to pick a folder when none is open
- **Empty-workspace prompt opens the full wizard**: The "Create New Project" offer shown in an empty folder used an old limited inline flow (6 templates, no options, no review) — it now opens the full wizard with all 9 templates and every step
- **Wizard template defaults apply even when you skip the options step**: Picking a template now pre-fills its option defaults (README/.gitignore/LICENSE for Empty, ESLint/Prettier/Jest for Node, Tailwind for Next.js, …), so jumping straight to Review no longer drops them
- **Wizard git branch name is honored**: The "Initial Branch Name" field was collected but ignored — `git init` used whatever your machine's default branch happens to be. The chosen branch (default `main`) is now actually created
- **ADO integration creates the work item**: The ADO Integration step collected work-item type and area path but did nothing with them. Creating a project with integration enabled now creates the work item in your active project (type + area path included); failures are reported in the success toast and never block project creation
- **Wizard errors are visible again**: Create failures used the global error banner, which sits behind the wizard's full-screen overlay — they now render inside the wizard and the Create button re-enables after a failure
- **Scaffolded projects are more solid**: Laravel scaffolds now include the missing `bootstrap/app.php` (artisan couldn't run) and emit valid PHP namespaces in `artisan`/`routes/web.php`; composer.json PSR-4 keys autoload correctly (single trailing backslash — the old double-escape broke autoloading); the Node.js Dockerfile uses `npm install` (no lockfile is generated, so `npm ci` would fail); .NET solutions get a real project GUID instead of a `{GUID-HERE}` placeholder; Next.js projects with Prisma actually list the dependency in package.json and Tailwind projects import their stylesheet
- **Project-name validation**: Empty or path-traversing project names are rejected up front with a clear message instead of writing outside the target folder

### Fixed
- **24 new tests covering every project type**: Each of the 9 templates (Node TS/JS, Python, PHP Laravel/plain, .NET Web API/Console, React, Next.js, Empty) is now exercised end-to-end — scaffolded files, git init, initial commit, branch name — plus option behaviour, validation, and the create-in-a-blank-directory flow. Generated Laravel PHP is also linted with `php -l` during verification

## [0.6.2] - 2026-08-25

### Improvements
- **Images inside work items are now retrieved and displayed**: Rich-text fields (Description, Acceptance Criteria, Repro Steps, System Info) and discussion comments can contain `<img>` tags pointing at ADO's attachment endpoint — those URLs require authentication a webview can't attach, so they rendered as broken images. The extension now fetches each attachment with your PAT and inlines it as a `data:image/...` URL before posting the detail to the chat task panel or the standalone work-item panel (capped at 10 images / 2 MB each / 8 MB total per field so the webview payload stays sane; failed fetches degrade to the old broken-image state instead of erroring). Live-verified against zencomputersystems work item 16096 ("Test Bug Item" — screenshot in Repro Steps + a comment both resolve). The standalone panel also gained an explicit CSP allowing `data:` images
- **Work Items view shows assignment at a glance**: Each item is now marked with an assignment cue — a **blue person** = assigned to you, an **orange person** = assigned to someone else, a **grey empty circle** = unassigned — so My / All / Unassigned items are identifiable at a glance in the merged tree (most useful in All mode, where the dataset is mixed). The work item type moves into the row description ("#123 · Task"), and hovering shows the assignee ("Assigned to you" / "Assigned to Jane Doe" / "Unassigned"), so the cue replaces the old type icon without losing information. The signed-in user is resolved once (cached profile call) and pushed to the tree on every refresh; agent-run spinners and the selection checkmark still take precedence

### Fixed
- **Numbered task lists are now posted to ADO**: The generate-tasks flow only parsed the model's ` ```json ` fence — when the model answered with a plain numbered list ("1. … 2. …"), a ` ```JSON ` fence, a bare ` ``` ` fence, or an unfenced JSON array, the whole batch was silently dropped (no review editor, nothing posted). The parser now tolerates heading/fence variants and falls back to parsing a numbered markdown list, so every proposed task reaches the review editor
- **Numbered/bulleted sub-items inside task descriptions no longer lost**: Task descriptions and acceptance criteria were truncated to their first line when the review file was parsed back (the field regex stopped at the first newline), silently dropping numbered steps from the created work item. Field parsing now captures the full multi-line body
- **Changelog comments posted to ADO are now cleanly formatted**: The completion-flow comment relied on single newlines, which ADO's markdown engine collapses (a soft break needs two trailing spaces), and embedded a work-item URL whose project segment was unencoded — project names with spaces (e.g. "Dummy Test Project") broke the markdown link, spilling the rest of the line as literal text. The comment is now block-structured with blank-line paragraph separators, its own clickable "Open in Azure DevOps" link bullet, and a backticked branch/commit bullet; org + project are percent-encoded in both the ADO comment and the local CHANGELOG.md entry
- **Created work items render their descriptions correctly in ADO**: `markdownToHtml` (which converts task descriptions/acceptance criteria into the HTML ADO expects) wrapped list items with a greedy regex that couldn't tell ordered from unordered lists apart — a numbered list following a bullet list was swallowed into the wrong wrapper or left as bare `<li>` outside any list (invalid HTML ADO renders as plain text), so numbered steps after a bulleted paragraph were still effectively lost on posting. The converter is now a line-based parser: consecutive `- ` lines become one `<ul>`, consecutive `N. ` lines become one `<ol>` (tag switches flush cleanly, indented continuation lines like the review-file round-trip produces count too), headings no longer drag a trailing `<br>`, code blocks are protected from newline conversion, and paragraphs stay balanced

## [0.6.1] - 2026-08-23

### Improvements
- **Cached repository + work-item understanding**: ADO Code now keeps a durable, fingerprinted understanding of the active repository and the selected ADO work item in `.ado-code/understanding/` — deterministic repo facts (branch/HEAD, top-level structure, AGENTS.md, package.json scripts, README head, workspace-memory keys), the selected work item's full context, and prior-session knowledge distilled from conversation condensations. The cached block is injected into **every chat session** (new sessions start from prior understanding instead of a cold start) **and every delegated-agent prompt** — including chat-driven delegation, which previously carried no repo context at all. Invalidation is fingerprint-based (git HEAD/branch or a changed AGENTS.md/package.json/README regenerates facts automatically); the LLM repo summary (one model call per repo change, toggle via `adoCode.understanding.autoSummarize`) regenerates async so chat turns are never blocked. Refresh manually anytime via **ADO Code: Refresh Repository Understanding**; toggle the whole cache via `adoCode.understanding.enabled`
- **DeepSeek Harness as a delegation agent**: `dsh` is now a first-class external agent — detected via `dsh --version`, delegatable from chat, `/delegate`, the work-item context menu, and the `delegate_to_agent` LLM tool. It runs through the `headless` profile (`dsh --profile headless -- "<task>"`), which prints the final assistant answer and exits 0 on completion / 1 on error; follow-ups use the synthesized one-shot pattern (headless has no session resume). A `--` guard keeps task text that starts with `-` from being parsed as CLI flags
- **Proper tree structure for the Work Items tree**: The tree now renders the real ADO hierarchy instead of flat roots. After fetching the base list (assigned to you / unassigned / all open), the extension walks UP the parent chain (Task → User Story → Feature → Epic) and DOWN the children via `[System.Parent] IN (...)` WIQL — so a Feature expands to show its User Stories, and Tasks nest under their parent Story/Task even when those parents are assigned to someone else. Items pulled in purely for hierarchy context are tagged "· context" (with an explanatory tooltip) so it's clear they aren't part of the base query. The walk is round-capped and deduped; if the IN query is rejected by an ADO org it falls back to per-parent `[System.Parent] = N` queries, and if the expansion still fails the tree falls back to the plain base list with a visible warning
- **Merged Work Items view with mode toggle**: My Work Items, All Work Items, and Unassigned Work Items are now ONE tree view ("Work Items") with a **visible mode header row** at the top ("View: My Work Items — click to switch ▾") that opens the mode picker — like the Chat|Plan|Act|Yolo toggle, the current mode is always in sight. The toolbar toggle + header row both switch datasets (All fetches every open item in the project), and the choice is remembered per workspace. Context menus are gated per ITEM, so Take Ownership / Reassign appear on unassigned items in every mode
- **Parallel tool execution (pi parity)**: Independent tool calls in a single model turn now run concurrently instead of one-after-another — several `read_file`/`search_files` calls or ADO reads finish in the time one used to take. Results are re-ordered back to call order so tool-id referencing stays valid. If a batch contains any call that needs a consent card, the whole batch runs sequentially so prompts never stack
- **Per-file mutation queue**: Parallel batches that edit the SAME file are serialized (read-modify-write can't interleave), while edits to different files still run in parallel
- **Truncated-response guard**: When the model hits its output token limit (`length`/`max_tokens`), tool calls are NOT executed — arguments may be truncated mid-JSON — instead each is failed with an explicit "re-issue with complete arguments" so the model retries correctly
- **Batched edits**: `edit_file` now accepts an `edits[]` array for several disjoint changes to the same file in one call (applied in order, each still verified — no silent no-ops). Fewer round-trips, fewer tokens
- **`search_files` grep tool is now real**: Previously advertised in the prompt but unimplemented, it now greps the workspace with a JS regex — `path:line` hits, per-line truncation to 500 chars with an explicit marker (pi-style), workspace path confinement, `node_modules/.git/dist/.vscode/out` excluded, binary files skipped, result caps (default 100 / max 200), and `file_pattern` (e.g. `src/**/*.ts`) or a `path` directory/file scope
- **`execute_skill` tool works again**: The system prompt told the model to call `execute_skill`, but the executor couldn't run it — every attempt errored as "unknown tool". It's now wired to the skill manager (read-only: loads the skill's instructions for the model to follow), so skills are usable from chat as advertised
- **External skill registries**: Browse and install community skills from remote TSV registries (`slug<TAB>url<TAB>description`). The built-in UI Skills registry is always included; add more via the new **`adoCode.skillRegistryUrls`** setting. A new `SkillRegistryService` fetches and parses registries (cached), downloads each skill's SKILL.md on install, and the Skill Catalog shows registry skills with a "registry" source badge — coordinated with built-in, local-imported, and registry skills by the SkillManager
- **Smarter prompt guidance**: The system prompt now tells the model to issue independent tool calls in the same request (so the parallel loop is actually used) and to batch disjoint edits into one `edit_file` call
- **Live agent progress in the editor**: Agent delegation progress can now be moved to the editor area. New `adoCode.agents.progressView` setting (default `chat`; `editor` auto-opens a live panel as soon as a run starts) — the panel streams real-time output as timestamped lines with event styling (worktree created, delegating to…, pre-agent hook, cancelled by user), shows a live elapsed clock, an animated progress bar while running, and follow/clear/copy log controls; on completion it morphs into the formatted summary. Any run can be moved to the editor on demand via the new ↗ button on the chat output panel (now available for running runs too, not just finished ones) or the **ADO Code: Open Agent Progress…** command; the chat output panels also gained a live elapsed-time readout while a run is in flight
- **Parent delegation completes child items**: Delegating a parent work item (Story, Feature, Epic) now covers its **whole descendant subtree** — children, grandchildren, and beyond — not just direct children. The agent prompt carries a numbered **delivery checklist** of every open descendant, and the agent is contractually required to end with a `## Delivery Report` (`- #1234: DONE | BLOCKED | INCOMPLETE`). When the run finishes, the extension parses that report and — with the new opt-in setting **`adoCode.agents.autoCompleteChildren`** (default `false`) — comments + transitions each DONE child to its terminal state (Task/Bug → *Closed*, Story/Feature/Epic → *Resolved*) and closes the parent once **all** open children are done, routing through the changelog completion flow. Partial success leaves the parent open with a comment listing what's still outstanding; a failed run never auto-closes anything. With the setting off, the run only reports and comments. Parent runs are also protected by a new **parent/child concurrency guard**: you can't delegate a parent while any of its children has its own active run (or vice versa), so worktrees and branches can't collide. Both entry points — chat delegation and the tree-view "Start Task with Agent" command — use the same subtree checklist and post-run sync
- **Main-model choice offers (zero extra cost)**: When the model's answer ends by offering you a choice ("Should I … or …?"), it now appends a fenced ` ```choice ` block with 2–6 short imperative options. The host parses that fence as the **primary** choice-detection path — no regex misses on natural-language offers, no extra LLM round-trip — and the chat webview strips the fence from the bubble so it renders as the clickable option card. The fast regex and the optional cheaper-model detection remain as fallbacks
- **Active editor context auto-injected per turn**: The file you're editing is now automatically included in each chat turn's context, so the assistant sees the code you're actually working on without you pasting it. Injection is deduplicated (only re-sent when the file or its document version changed) and oversized selections are capped
- **Slimmer session persistence**: Sessions now persist only the last 25 complete user/assistant message pairs (plus the leading condensation/truncation marker) instead of the full conversation — smaller restore payloads and cleaner rehydration while keeping the same conversation context
- **AGENTS.md honored in chat**: The chat system prompt now instructs the model to read and honor an `AGENTS.md` at the workspace root when present — parity with agent handoffs — reading it on demand so absent files cost nothing per request
- **Iteration budget clarified**: `adoCode.act.toolBudget` is now surfaced as "Iteration budget" (each iteration is one model round-trip that may run several tool calls in parallel), with the default constant centralized in one shared place; the legacy config key is still honored
- **Provider-native token counting refined**: Native counting is now forced ON for Anthropic (its `/count_tokens` endpoint is free) and stays opt-in for OpenAI-compatible gateways via `adoCode.llm.useNativeTokenCounting`; status-bar counts now include the current system prompt, so the number reflects what's actually billed

### Fixed
- **Tolerant `System.Parent` parsing**: Some ADO orgs serialize the parent link as a bare integer instead of `{ id }` — parent ids are now parsed from either shape (object, number, or string), so the Work Items tree nests even when the org returns the flat form
- **Conversation summaries silently dropped on Anthropic**: Condensation summaries were prepended as mid-array **system** messages — the Anthropic providers hoist only the FIRST system message, so the summary vanished and the model lost the condensed context. Summaries are now marker-prefixed **user** messages, surviving every provider's message shape (matching the truncation summary)
- **Laravel scaffold generated broken PHP**: The `artisan` and `routes/web.php` templates used `\C`/`\$` escapes that JavaScript template literals silently collapse — the generated files lost every PHP namespace separator (`Illuminate\Contracts\Console\Kernel` became `IlluminateContractsConsoleKernel`). The templates now emit valid PHP namespaces and variables
- **Security: dompurify bumped to 3.4.14** in the webview bundle (fixes the flagged moderate vulnerability)
- **dsh delegation for existing users**: Users whose stored `adoCode.agents.enabled` predates DeepSeek Harness (the previous default list) silently lost dsh — the allowlist never probed it. The registry now migrates that exact stale default in-memory so dsh is available again; custom pruned lists are respected and never overridden

### Changed
- **Tree diagnostics in Output → ADO Code**: The refresh now logs `Work item hierarchy: N items (M base, K context)`, a one-time `System.Parent raw sample: …` line (shows which serialization shape your org uses), and a per-refresh `Work items tree: N items (K with parentId, R roots)` line — a flat tree is now instantly diagnosable
- **Single tool implementation path**: Removed the legacy Roo-Code-style layer (`BaseTool`, `ToolRegistry`, the `definitions/` schemas, and the five per-tool classes) — all tool execution lives in the one `createToolExecutor()` switch in `src/llm/tools.ts`, which was already the path the agentic loop used. Also removed the abandoned BaseProvider migration (`handler.ts`, `openai-v2.ts`, `anthropic-v2.ts`) and the unused approval-decision helpers in `consent.ts`. Dead tool names (`list_files`, `ask_followup_question`, `attempt_completion`) were dropped from the type/display map — net −2,500+ lines
- **Docs updated**: `docs/playbooks/add-tool.md` rewritten for the single-path architecture, `docs/chat-token-optimization.md` refreshed with the new optimizations, AGENTS.md reflects the current tool system
- **Lint-clean + dead code removed**: All 37 ESLint errors fixed (inline `require()`s moved to top-level imports, regex character-class escapes corrected, unused imports/locals/params removed). Deleted the unused `ContextProxy` module (`src/config/ContextProxy.ts`), the never-imported `AgentBar`/`LoadingSpinner` webview components, and the dead `matchCommands` helper. `tsconfig.json` now sets `noUnusedLocals` + `noUnusedParameters`, so the build enforces dead-code-free source; `.eslintrc.json` honors the `_`-prefixed unused-parameter convention. ESLint now reports **0 errors** (remaining output is `no-explicit-any` warnings only)
- **Test runner env hook**: `ADO_CODE_TEST_EXTRA_ARGS` lets you pass extra VS Code launch args for sandboxed/container environments (e.g. `--no-sandbox --disable-dev-shm-usage`)

## [0.5.9] - 2026-08-21

### Improvements
- **Live thinking + tool progress in chat**: While the AI works, the chat window now streams its reasoning into a 💭 Thinking block and shows every tool call as a live card — the card appears as **running…** with a spinner (arguments visible) while the tool executes, then flips to **completed** (or **error**) with its result. No more sitting through a silent "Thinking…" until the final answer
- **Permanent tool-call record**: When the turn finishes, the tool cards are merged into the assistant message above the answer as collapsible blocks — review what the agent did, expand any call to see its arguments and result, and they survive session history
- **Hide tool calls in chat**: New `adoCode.chat.showToolCalls` setting (default on, in Configuration → Chat) hides the tool cards — tools still run normally, but the chat shows only a subtle pulsing "…" indicator and no tool names, arguments, or results ever reach the chat (or session history)
- **Show AI thinking is now enforced**: The existing `adoCode.chat.showThinking` toggle (Configuration → Chat) previously had no effect — thinking text was always displayed. It now actually hides/shows the reasoning block in every path (agentic loop, streaming fallback, auto-review)
- **Wildcard permissions**: Two ways to grant broader permission "to a certain extent":
  - `adoCode.consent.autoApproveTools` (Configuration → Consent) — tool names or glob patterns like `read_*`, `get_*`, `edit_file` run without a consent prompt in inline/act modes (plan stays read-only). Setting `run_terminal_command`/`run_*` behaves like yolo for shell commands
  - `adoCode.act.terminalAllowlist` entries now support wildcards: `git *` allows every git subcommand, `git push *` only pushes, `npm run *` any npm run script — matched token-by-token with no shell operators, so `*` can't smuggle in `&&`/`|`
- **Wildcard-aware session approvals**: "Allow for Session" choices also honor patterns, so approving `git *` once covers every git command for the rest of the session
- **Token consumption optimization for the agentic loop**: tool results are capped to a token budget (`read_file` defaults to a bounded window, terminal/work-item/list output is trimmed head+tail) and older tool results are compacted to stubs once the model has seen them — the largest source of re-send cost on long turns; plan mode now sends only read-only tool schemas
- **Provider-native token counting**: the token status bar now uses the provider's own tokenizer (Anthropic `/v1/messages/count_tokens`, free; OpenAI-compatible via `usage.prompt_tokens`), throttled with the local heuristic as an instant fallback. Toggle `adoCode.llm.useNativeTokenCounting` (default on)
- **Accurate token budget**: context truncation/condensing and the status bar now account for the system prompt + tool schemas that ride along with every request, not just the conversation text

### Changed
- **Reorganized Configuration UI**: Settings are now grouped into navigable sidebar categories — **Connection** (Azure DevOps + LLM Provider), **AI & Modes** (Mode, Act Mode, Chat, Sessions), **Permissions** (Consent), **Workflow** (Git, Changelog, Work Items, Workspace), and **Integrations** (Agents + MCP Servers) — each with a setting-count badge, so you can jump straight to what you need instead of scrolling past everything to find it
- **Advanced Configuration is now a real category**: The Advanced toggle (in the sidebar) gates a dedicated **Advanced** category that bundles the per-mode model selection, **Model Capability Overrides** (previously only editable in settings.json — now structured rows in the UI), the **choice detection model** (`adoCode.llm.choiceDetectionModel`), and the **native token counting** toggle (`adoCode.llm.useNativeTokenCounting`). Toggling it on jumps straight to the advanced settings; toggling it off while viewing them returns to Connection

## [0.5.8] - 2026-08-15

### Improvements
- **Skill Catalog UI overhaul**: Redesigned with pill-style category filters, search with icon and clear button, accent stripes on cards, status indicators (active/disabled), collapsible prompt preview sections, and polished detail view with hero header
- **Activity indicator in chat**: Shows a spinner + text banner while executing skills ("Executing skill: Code Review…") or generating tasks ("Generating tasks…") — clears when the AI response arrives
- **Instant chat refresh**: Session switches and history restores now jump straight to the latest message instead of scrolling from top to bottom
- **Skill persistence**: Imported skills now survive VS Code restarts — full skill data is stored in globalState, not just IDs
- **Fixed "Execute in Chat"**: Previously sent the skill prompt to the extension but never injected it into the chat — now properly injects the skill's prompt as a user message and triggers the LLM

### Features
- **Skill import from local files**: Import skills from .json files, SKILL.md files (YAML frontmatter + markdown body), or .tar.gz/.tgz/.zip archives containing skill packages
- **Expanded builtin skills**: 4 new builtin skills — Deployment Checklist, Database Schema Review, Accessibility Audit (now 10 total across 10 categories)
- **Local skill import button**: "+" Import button in the Skill Catalog toolbar opens a file picker supporting all skill formats
- **Send Selection to Chat**: Right-click any selected text in the editor → "ADO Code: Send Selection to Chat" inserts it as a fenced code block in the chat draft — the chat panel auto-focuses if hidden
- **Send File to Chat**: Right-click a file in the Explorer → "ADO Code: Send File to Chat" attaches it as a chip above the input bar with full content ready to send
- **Delete All Sessions**: New `/clear-sessions` slash command + "🗑️ Delete All Sessions" button in the session history dropdown and kebab menu — wipes all sessions after in-chat confirmation (with `isDangerous: true`)
- **Confirmation cards for destructive operations**: Single session delete and delete-all now show in-chat confirmation cards instead of silently executing
- **Categorized `/help`**: The help output is now grouped into Work Items, Chat, AI, and Other sections with a tip about autocomplete

### Fixed
- **Configuration settings not persisting**: Advanced Configuration toggle, consent auto-approve settings, agent auto-review, chat show-thinking, per-mode model config, and per-mode reasoning effort were not loaded by `_allSettings()` — the ConfigurationPage showed defaults instead of saved values, and saving would overwrite real values with defaults
- **Missing VS Code settings declarations**: Added `adoCode.consent.harmlessAutoApprove`, `adoCode.consent.harmlessAutoApproveSeconds`, and `adoCode.chat.showThinking` to `package.json` contributes.configuration so they appear in VS Code's native Settings UI

## [0.5.7] - 2026-08-09

### Features
- **Task draft editor**: The `create_work_item` LLM tool now opens an editable markdown tab before creating work items in ADO — review, edit fields (title, description, acceptance criteria, assigned to, tags), then confirm via an in-chat card. Catches mistakes before they hit the backlog
- **YOLO mode**: New fully-autonomous mode that auto-approves every tool including shell commands — no consent prompts, no allowlist. Use `/mode yolo`, the mode toggle (Chat|Plan|Act|YOLO), or the Configuration page. Skips all consent and terminal allowlist checks
- **Consent auto-approve timer**: Harmless (read-only) terminal commands (git status/diff/log, npm test, ls, cat, etc.) show a countdown timer on the consent card; the command auto-approves when the timer expires. Configurable via `adoCode.consent.harmlessAutoApprove` (default off) and `adoCode.consent.harmlessAutoApproveSeconds` (default 20s, range 1–30). Read-only command detection covers git (status, diff, log, show, branch, remote, tag, blame), npm (test, run, list, info, view), pip, yarn, and common base commands (ls, cat, grep, find, etc.)
- **Show AI thinking**: Models that return thinking/reasoning tokens (o1/o3 reasoning_content, Claude extended thinking) now display their internal reasoning in a collapsible blue thinking block while streaming. Configurable via `adoCode.chat.showThinking` (default `true`). Works automatically with supported models; no effect on models that don't expose thinking tokens
- **Improved context size detection**: Content-aware token counting (code ~3.5 chars/token, prose ~4.5) replaces naive char/4 estimation; expanded model context window table (27 models including Gemini 1M/2M); better substring matching for model lookup; default context window raised from 8k to 128k
- **Dynamic context window from API**: Context window size is now auto-detected from the `/models` endpoint — Ollama `meta.n_ctx`, OpenRouter `context_length`, and other providers. Live data takes precedence over the hardcoded table and auto-updates the ContextManager when models are fetched
- **Context management**: Priority-based conversation truncation replaces naive 20-turn cutoff; real token counter replaces rough char/4 estimation; conversation auto-condenses at 75% context via LLM summarization; token status bar shows accurate model-aware counts
- **Mode-aware system prompt**: Dynamic prompt generation includes mode-specific role, available tools, tool guidelines, environment context, and memory injection
- **Tool budget configurable**: Max tool calls per act-mode turn now adjustable in the Configuration page (recommended: 15-30) with min/max constraints
- **MCP server management**: Right-click MCP servers in the Status Panel to disconnect, reconnect, or view details
- **Mode quick-cycle**: Right-click the Mode item in the Status Panel to cycle through inline/plan/act
- **Worktree batch cleanup**: Remove All Completed action on the Worktrees root node
- **Agent run history**: Recent Runs section in the Status Panel shows last 10 completed runs with status icons, timestamps, and context menu (View Summary, Open Worktree, Copy Run ID)
- **Agent details panel**: Right-click agent in Status Panel to view name, binary, version, supported modes, and CLI arguments
- **Memory search**: QuickPick fuzzy search across all user and workspace memory entries
- **Memory import/export**: Export memories to JSON; import with merge or replace option
- **Keyboard shortcuts**: Ctrl+Shift+M cycle mode, Ctrl+Shift+/ search memories, Ctrl+Alt+R refresh status
- **Worktree diff viewer**: Show Changes opens VS Code diff editor for worktree files
- **Agent auto-review**: Git diff automatically reviewed by LLM on agent completion with merge recommendation
- **Work item filtering**: Filter Work Items tree by state, type, or text search with smart parent visibility
- **Changelog on update**: After a version change, a one-time notification offers to show the new version's changelog in a styled webview panel
- **Generate tasks from user story**: New `create_work_item` LLM tool creates ADO work items; `/generate-tasks` slash command and context menu action trigger the AI to analyze a user story and generate child tasks
- **Agent progress in chat**: Agent delegation now shows start/completion messages in the chat thread alongside the streaming output panel
- **Merge-flow guardrails round 2**: `commit_worktree` now refuses to commit a run whose verification FAILED unless the assistant explicitly passes `allowFailed` (after reviewing); `create_pull_request` refuses to open a PR against protected branches (`adoCode.git.protectedBranches`, default `["main", "master"]`); new `resolve_pr_conflicts` tool lists conflicted files with base/our/their contents so the assistant can resolve them via edit_file/apply_diff, then re-commit/re-push until the PR is clean
- **Child task delegation**: When delegating a work item to an agent (via `delegate_to_agent` tool or `/delegate` slash command), the system now checks for child work items in ADO. If child tasks exist, a confirmation card warns the user and offers to include them in the agent's context. When included, child tasks are appended to the agent prompt so the agent implements all of them
- **Clean Up After Merge**: New context-menu action on the Worktrees view and auto-offer after a merged PR — removes the run's worktree and deletes its branch, but only when the ADO pull request is actually completed+merged and the branch is fully merged; nothing is ever lost
- **Capability overrides**: `adoCode.llm.capabilityOverrides` (array of `{ model, vision?, tools? }`) lets you declare vision/tool-calling support per model id, beating every auto-detection layer. Structured editor in the Configuration page (LLM Provider → Capability overrides) adds/removes rows with model id + checkboxes; unchecked fields keep the auto-detected value
- **Live model capabilities**: Detection is now three layers — user override > live gateway data (OpenRouter `architecture.input_modalities`, Ollama `capabilities[]` from `/models`) > name heuristic. The heuristic now covers gpt-5, o1–o9, llama-4, gemma-3, deepseek-vl, glm-4.5v, minicpm, and more
- Removed redundant "Select Work Item" context menu entry (was duplicated across two menu groups)

### Bug Fixes
- **Choice-card answers went stale**: Clicking an option on an AI-posed question posted `sendMessage`, which the host silently dropped — the chat showed your answer and "Thinking…" forever with no LLM turn ever starting. Choice answers now route through the same turn path as typed messages
- **"spawn git ENOENT" on legacy worktrees**: Commit & Push / Clean Up After Merge failed on worktrees created by older versions (`run-run-…` directories) — the path resolver now checks both directory layouts. ENOENT errors are also re-phrased to say whether the worktree directory is missing or git isn't on the VS Code process PATH
- **Pre-commit hook git env var pollution**: The pre-commit hook now clears `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_WORK_TREE`, and other git env vars so the test suite (which shells out to git in temp repos) doesn't inherit stale hook state

## [0.5.6] - 2026-08-07

### Features
- **Capability overrides**: You know your model best — `adoCode.llm.capabilityOverrides` (array of `{ model, vision?, tools? }`) lets you declare vision/tool-calling support per model id, beating every auto-detection layer. A structured editor in the Configuration page (LLM Provider → Capability overrides) adds/removes rows with model id + checkboxes; unchecked fields keep the auto-detected value
- **Live model capabilities**: Detection is now three layers — user override > live gateway data > name heuristic. Gateways that expose capabilities on `/models` (OpenRouter `architecture.input_modalities`, Ollama `capabilities[]`) are read directly, so brand-new or custom model ids report correctly without pattern updates; the heuristic fallback now also covers gpt-5, o1–o9, llama-4, gemma-3, deepseek-vl, glm-4.5v, and more
- **Protected PR targets**: `adoCode.git.protectedBranches` (default `["main", "master"]`) — `create_pull_request` refuses to open a PR against a protected base branch, so the assistant can't accidentally target production
- **Merge-flow guardrails**: Committing a FAILED agent run is refused unless the assistant explicitly passes `allowFailed` (after reviewing); `resolve_pr_conflicts` surfaces git merge conflicts (base/ours/theirs contents) so the assistant can resolve them, re-commit, and re-push until the PR is clean
- **Clean Up After Merge**: New context-menu action (and auto-offer after a merged PR) that removes the run's worktree and deletes its branch — but only when the PR is actually merged and the branch is fully merged; nothing is ever lost

### Bug Fixes
- **Choice-card answers went stale**: Clicking an option on an AI-posed question posted `sendMessage`, which the host silently dropped — the chat showed your answer and "Thinking…" forever with no LLM turn ever starting. Choice answers now route through the same turn path as typed messages
- **"spawn git ENOENT" on legacy worktrees**: Commit & Push / Clean Up After Merge failed on worktrees created by older versions (`run-run-…` directories) — the path resolver now checks both directory layouts. ENOENT errors are also re-phrased to say whether the worktree directory is missing or git isn't on the VS Code process PATH

## [0.5.6] - 2026-08-06

### Features
- **Dedicated Worktrees view**: New sidebar tree showing every agent worktree with per-worktree details — run status (color-coded), agent, work item, dirty/clean files, last commit, ahead/behind, and path. Refreshes automatically on run status changes (start/cancel/complete) and after removal. Context menus shared with the old Status-panel listing: Open in Terminal, Open in Explorer, Remove, and new **Show Agent Output**
- **Reopen agent output**: Closed summary panels are no longer lost — finished runs get a "↗ Reopen" button and a "Reopen output" link in the chat panel, plus right-click → **Show Agent Output** in the Worktrees view. Summary panels now dedupe: reopening reveals and refreshes the existing panel instead of stacking duplicates
- **Memory-driven agent hooks**: Workspace memory keys `agent.before` and `agent.after` hold shell commands that run around every agent invocation — `agent.before` executes in the agent's worktree before the adapter starts (output streams to the run panel), `agent.after` runs on completion and its output is captured into the summary. User and workspace memory are also injected into every agent handoff prompt as "ADO Code Memory (instructions you MUST honor)" (hook keys excluded so agents don't re-run them)
- **Model capability checking**: The extension infers the active model's capabilities (`vision`, `tool calling`) from its id. Models without vision get image paste/attach disabled in the chat; models without tool calling trigger a persistent warning that agentic modes degrade to plain chat. The Configuration page shows a live capability readout for the selected model and highlights models lacking tool calling
- **Model list retrieval in Configuration**: Once an API URL and API Key are entered, a "Fetch Models" button lists models from the endpoint (OpenAI `/models` or Anthropic `/v1/models`) and lets you pick one; failures render inline
- **`.ado-code` auto-ignore**: The workspace data directory (memory, checkpoints, agent runs) is now offered to be added to `.gitignore` and `.dockerignore` when missing (setting `adoCode.ignore.dotAdoCode`, default on; a declined offer is remembered per workspace)
- **AI merge flow**: The assistant can now execute the whole merge flow for a finished agent run itself via three new tools — `commit_worktree` (commits all worktree changes; refuses unknown/still-running runs), `push_worktree` (never force-pushes, refuses `main`/`master`), and `create_pull_request` (ADO Git REST, refuses same source/target). Instructions are injected into the system prompt; the tools are consent-gated in inline mode, auto-approved in act mode, and blocked in plan mode
- **Worktree merge guardrails**: `delegate()` refuses a second concurrent run on the same work item (both would share a branch) and warns when an existing branch is behind the base (stale-code risk). New **Commit & Push** context-menu action; **Remove** now offers *Commit & Push, then Remove* when the worktree is dirty, and deletes the local branch afterwards only if it is fully merged (unmerged branches are kept — commits are never lost)
- **Working indicator**: A status-bar spinner (`$(sync~spin) Working…`) shows while any LLM turn or agent run is in flight — host-side, so it stays visible when the chat view is hidden — and updates live with what the AI is doing ("thinking…", "tool: edit_file")
- **Background processing survives view changes**: Closing/hiding the chat panel no longer force-denies pending consent mid-turn — the LLM loop keeps running host-side, the 120s consent timeout remains the hang-safety net, and a pending consent card is re-posted when you return
- **AI choice detection (LLM-assisted)**: Responses that ask a question without numbered options (e.g. "Want me to … and/or …?") are now parsed by a cheap-AI extraction pass (setting `adoCode.llm.choiceDetectionModel`; `off` disables it). Choice buttons now actually work — clicking one sends the option as a follow-up message — and long option labels stack as full-width rows
- **Sessions auto-create**: The first chat message now creates a session (named from the message) — no more "No sessions yet" for users who never clicked New Session, and the conversation is actually persisted
- **Full Configuration page coverage**: Every contributed setting now round-trips through the page — including a structured **Organizations** editor (name/URL/project), the **choice detection model** field, and a new **Workspace** section for the `.ado-code` ignore toggle

### Improvements
- **Branch names use the ADO subject**: Delegated agent worktree branches are slugged from the work item title (e.g. `feature/ADO-42-fix-login-bug`) instead of the prompt's first line ("read-and-follow-…")
- **Tree view title bars cleaned up**: The cramped title-bar strip no longer holds Refresh/Deselect buttons — Deselect Work Item moved into the row context menu (shown only while a selection exists), refresh stays reachable via command palette, `ctrl+shift+r`, and the chat header
- **Worktree directories named after the run**: Directories under `.ado-code/worktrees/` are now exactly the run id (no `run-run-…` double prefix); legacy directories still list and clean up correctly
- **Consent deny-once per command**: After one consent denial in a turn, only the SAME tool (or exact terminal command) is auto-denied for the rest of the turn — new commands still prompt; `beginTurn()` resets each message
- **"Allow for Session" for every tool**: All mutating tools now offer it on the consent card (was terminal-only); approvals skip the prompt and are cleared when the chat is cleared or a new session starts

### Bug Fixes
- **Dismissed agent runs no longer reappear**: Dismissing a finished run is now persisted host-side, so panel remounts, re-focus, and extension reloads keep it dismissed
- **Duplicate agent summary panels**: Reopening a summary while its panel is still open revealed a second panel — it now reveals and refreshes the existing one
- **Worktree branch labels were commit hashes**: `git worktree list --porcelain` puts the branch on a `branch` line — the parser read the bare `HEAD` hash, so every worktree was labeled with a commit id
- **"No sessions yet" despite chatting**: The first message now auto-creates a session — previously conversations were never persisted (and the history list stayed empty) until the user clicked New Session
- **Configuration page could wipe MCP servers**: `mcp.servers` was missing from the settings payload, so the page loaded it empty and Save overwrote real server configs with `[]` — all settings now round-trip
- **Derived values written to settings**: The model-capabilities payload was being saved back as a junk `adoCode.modelCapabilities` setting — derived values are excluded from saves

## [0.5.5] - 2026-08-06

### Features
- **Git worktree isolation for concurrent agents**: Each agent run now gets its own isolated git worktree under `.ado-code/worktrees/`, preventing branch conflicts and file corruption when multiple agents run simultaneously
- **Multi-agent output panels**: Multiple agent runs now display as separate collapsible panels in the chat, each with independent streaming output and a close button for completed runs
- **Agent summary in formatted webview panel**: Agent completion summaries now open in a styled HTML panel (like WorkItemDetailPanel) instead of a raw markdown preview, with metadata, status badge, and duration
- **Status Panel context menus**: Right-click actions on Status Panel items:
  - Memory: Delete, Move to User/Workspace memory
  - Agents: Open in Terminal, Copy Agent Name
  - Worktrees: Open in Terminal, Open in Explorer, Remove
- **Work item selection highlighting**: Selected work items now show a green check icon with "◀ active" badge in the tree view
- **Deselect Work Item**: New command to release the active work item selection (title bar button + context menu)
- **AI choice prompt detection**: When the AI asks the user to choose between options, the response is parsed and displayed as an inline confirmation card with clickable buttons
- **Reassign Work Item**: Fixed missing context menu entry for reassigning work items to other team members

### Improvements
- **Universal ADO API fallback**: All ADO REST API calls now try the GA version (7.1) first and automatically retry with preview (7.1-preview.4) if the org hasn't rolled out GA yet
- **Status Panel live updates**: Memory changes now trigger debounced tree refreshes; configuration changes are categorized to avoid unnecessary agent re-detection
- **Worktree listing in Status Panel**: Active agent worktrees are displayed in the Status Panel with branch names and run IDs

### Bug Fixes
- **Reassign Work Item 400 error**: Fixed API version mismatch — PATCH endpoint now uses correct preview version with automatic fallback
- **Single agent output overwrite**: Fixed issue where only one agent's output was visible when multiple agents ran concurrently
- **Agent summary cluttering chat**: Agent summaries no longer append to chat panel output — they open in a dedicated editor panel

## [0.5.4] - 2026-08-05

### Bug Fixes
- **Slash commands no longer leave chat stuck at "Thinking"**: `/comment`, `/status`, `/assign`, `/pick`, `/mode`, `/undo`, and `/help` now clear the loading spinner after execution
- **Task detail panel persists across panel collapse/reopen**: The selected work item's detail panel now survives VS Code panel hide/show cycles via webview state persistence and host-side re-fetch
- **Task detail panel no longer blocks chat input**: Detail panel is now constrained to 40vh max with internal scrolling, so the chat input is always accessible
- **Removed dead AgentBar dropdown**: The agent selection dropdown in the chat was never wired to anything — agent delegation happens via context menu or `/delegate` command. Removed to reduce clutter
- **Secondary side bar support**: Fixed container ID conflict and registered views so all panels (Chat, Work Items, Status) can be moved to the secondary side bar via right-click → "Move View"
- **STATUS tree shows agents after load**: Agent list in the Status tree view now appears correctly — the tree refreshes after async agent detection completes
- **Pi agent now receives project context**: Agent delegation injects AGENTS.md content into the prompt, so Pi (which doesn't auto-read project files) understands the codebase structure
- **AGENTS.md generation prompt**: When opening a workspace without AGENTS.md, users are prompted to auto-generate it with detected build commands, project structure, and conventions
- **Git init prompt**: Non-git workspaces are detected on load and users are offered to run `git init` with confirmation
- **Empty workspace project scaffolding**: Empty directories trigger a setup wizard — choose project type (Node.js TS/JS, Python, PHP/Laravel, .NET C#), enter name, auto-generate files + optional git init
- **Workspace-to-ADO project binding**: `.ado-code/config.json` ties the workspace to a specific ADO project/org. On load, mismatches are detected and the user is warned — prevents accidentally working on items from the wrong project. Binding prompt also appears when switching projects via the project switcher or configuration page

### Improvements
- **"Start Task" confirmation and detail panel**: Clicking the rocket icon on a work item now shows an in-chat confirmation card, changes ADO status to "Active", creates a feature branch, and displays the full task detail panel in the chat
- **In-chat confirmation cards**: All user confirmations and selections (task start, uncommitted changes, underspecified task, mode switch, session resume, push/PR, agent default) now render as styled cards inside the chat instead of native VS Code popups — consistent with the existing consent card pattern
- **MCP Servers in Configuration page**: New "MCP Servers" section in the Configuration page — add, edit, and remove Model Context Protocol server connections (name, command, args, timeout) with a card-based editor
- **Hierarchical work item trees**: My Work Items and Unassigned Work Items now show parent-child hierarchy (Epic → Feature → User Story → Task) matching the ADO structure, with collapsible nodes and type-specific icons (layers, flag, checklist, bug, etc.)
- **Full detail view in editor**: Right-click any work item → "Show Full Details" opens a formatted detail panel in the main editor area with metadata, description, acceptance criteria, bug fields, and discussion thread
- **Slash command descriptions now include parameter hints**: `/assign`, `/status`, `/delegate` and others show what arguments they expect directly in the autocomplete dropdown
- **Status panel only shows installed agents**: Non-installed agents are hidden from the Status tree view — no more "not found" clutter
- **AGENTS.md check on new sessions**: Opening a workspace without AGENTS.md prompts the user to generate it with detected project structure

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
- **Tag/chip input for array settings**: Configuration page array fields (Terminal allowlist, Enabled agents) now use a visual tag/chip interface — type and press Enter or comma to add items, click × to remove


### Bug Fixes
- **Secondary Side Bar support**: Added `secondaryBar` views container registration so ADO Code views can be moved to the Secondary Side Bar via right-click context menu

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
