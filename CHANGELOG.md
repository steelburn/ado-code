# Changelog

All notable changes to ADO Code will be documented in this file.
## [Unreleased]

### Fixed
- **A message typed while a tool is running now interrupts that tool instead of waiting for it.** Steer-mode text was only drained at the *top of the next agentic iteration*, so a blocking `run_terminal_command` (up to its 2-minute timeout) held the turn open and the user's reply could not get through. The abort signal is now threaded per tool call (`getToolSignal` → `ToolExecutor.execute(name, args, signal)`), and `run_terminal_command` kills the child process and resolves with a machine-readable `{"interrupted":true,…}` result (new `src/shared/toolInterrupt.ts`) the instant the signal fires; a same-session message that starts a new turn also cancels any tool still in flight. The turn itself is not aborted — the steer is injected on the next iteration. Covered by `src/test/suite/shared/toolInterrupt.test.ts`, `src/test/suite/llm/agenticToolSignal.test.ts` and `src/test/suite/webview/chatViewProviderInterrupt.test.ts`.
- **A long tool command no longer pushes the approval card's buttons (and the input bar) off-screen.** The inline consent card rendered `run_terminal_command`'s full command text verbatim inside a rigid, non-scrolling row below the transcript, so a heredoc or `node -e "…"` one-liner wrapped into hundreds of lines and shoved Allow/Deny and the message box past the fold with no scrollbar to reach them. The summary is now clamped to a one-line, ~200-char preview via the new shared `buildTextPreview()` helper (with a "Show full command" toggle), the card itself is bounded (`max-height: 45vh` with an internally scrolling body), the transcript's tool-argument block is capped like the result block, and the host clamps oversized string args (`truncateConsentArgs()`) before posting the consent payload. Clamping is display-only — approval is keyed by `requestId`, so the command that runs is unchanged. Covered by `src/test/suite/shared/consentPreview.test.ts`.
- **Agent worktree creation is now Windows-safe.** `GitService.createWorktree` created its base directory by spawning the `mkdir` binary with `-p`; Windows has no such executable (and `-p` is not a valid flag), so the spawn failed with `ENOENT` and an agent worktree could not be created at all. It now uses `fs.promises.mkdir(base, { recursive: true })`. `listWorktrees` had a matching bug: it compared git’s forward-slash worktree paths against a native (backslash) base path with `startsWith`, which is always false on Windows, so agent worktrees were never listed — it now compares resolved paths.
- **Headless `vscode` stub: `ThemeIcon` now retains its `ThemeColor`.** The stub’s `ThemeIcon` constructor ignored its second argument, so `icon.color` was always `undefined` and the three `WorkItemsTreeProvider` assignment-icon tests failed against the stub. It now stores the colour, matching the real VS Code API shape (`icon.color.id`).
- **Moving the chat into the Editor Area no longer drops an open in-chat prompt.**
  Tool-consent and confirmation popups are rendered by whichever webview hosts the
  conversation. When the chat was moved into an editor tab, a pending card stayed
  stranded in the now-hidden sidebar webview, so the prompt disappeared from view.
  `ChatViewProvider` now tracks editor-panel visibility and re-posts any pending card
  into the new surface whenever the chat moves (editor ⇄ sidebar), and it only pauses
  prompt countdowns when *neither* chat surface is visible — so a card open in the
  editor keeps ticking while the sidebar is collapsed. Covered by new tests in
  `src/test/suite/webview/chatViewProvider.test.ts`.
- **Webview unit suites are green again — the `ChatViewProvider` tests were failing on an incomplete mock.** `syncTodoSession()`, the session rename/remove handlers and `createNewSession()` all dereference `services.todos`, but the tests built the provider with `{}` as `services`, so every session path threw `Cannot read properties of undefined (reading 'setActiveSession')`. Added a `makeServices()` helper (a no-op to-do store) and applied it at every construction site in `chatViewProvider.test.ts` and `conversation.test.ts`. Two `scripts/vscode-stub.js` gaps were fixed alongside: `WorkspaceConfiguration.update()` is now observable by a later `get()`, and `require('vscode')` returns one cached stub so an API a test spied on is seen by the code under test. `chatViewProvider.test.ts` 18 → 0 failures; `conversation.test.ts` 6 → 0.
- **Webview tree and mermaid suites are green again — the headless `vscode` stub now models `TreeItem`, `ThemeIcon` and `MarkdownString` for real.**
  `todoTreeProvider`, `worktreesTreeProvider` and `mermaid` build real tree nodes, but the
  stub's `TreeItem` was a permissive proxy whose `set` trap swallowed writes — so
  `node.label` / `node.id` / `node.sessionId` came back as a function and every assertion
  failed (33 failures). The stub now supplies concrete `TreeItem`,
  `TreeItemCollapsibleState`, `ThemeIcon`, `ThemeColor` and `MarkdownString` classes (a real
  `EventEmitter`, `Uri` and in-memory `workspace.fs` round it out). A new
  `src/test/suite/shared/vscodeStub.test.ts` guard pins these contracts — including the
  observable `WorkspaceConfiguration.update()` and the cached-stub singleton — so they cannot
  silently regress. Full webview suite 178 → 211 passing, 33 → 0 failures.
- **`createNewSession()` can no longer mint two sessions with the same id.** Session ids came straight from `new Date().toISOString()` (millisecond resolution), so a rapid "New Session" — or any flow that opens a fresh session per work item — could create two sessions within the same millisecond. Because the id is also the active-session key, the second session silently failed to become active. A new `newSessionId()` helper suffixes a counter until the id is unique among the sessions already stored.

- **`npm test` no longer dies before it starts when the shell already lives inside Electron.**
  `@vscode/test-electron` launches the downloaded VS Code by copying the parent environment
  verbatim (`Object.assign({}, process.env, ...)`), so an inherited `ELECTRON_RUN_AS_NODE=1`
  — present in a VS Code integrated terminal, the extension host, and agent runners — made the
  child `Code.exe` boot as a plain Node process. Node then rejected the harness's own CLI flags
  (`Code.exe: bad option: --disable-extensions`, exit 9) and not a single test executed. The
  variable is now scrubbed before launch. `--disable-extensions` itself is valid and stays; the
  launch args and env are extracted into `src/test/launchConfig.ts` so the contract is covered by
  the headless `src/test/suite/shared/launchConfig.test.ts` guard.

- **The Electron harness's Windows temp-directory cleanup no longer stalls or leaks.** `cleanTempDir()`
  ran `git gc --prune=now` before deleting each temp directory "to release Git locks", but gc runs
  synchronously (seconds per repo) and auto-detaches, so it could itself *hold* the directory open and
  make the delete fail with EPERM. `projectCreation`'s `afterEach` sweeps every leftover temp dir, so
  the cost compounded until the suite's 20 s hook timeout tripped and the undeletable directories piled
  up across runs. The gc step is removed (the `attrib -R` pass already clears the read-only git
  objects) and the recursive delete now retries transient Windows handle locks. Guarded by
  `src/test/suite/shared/cleanTempDir.test.ts`; the full `npm test` now runs end-to-end
  (927 passing, 0 failing, exit 0).
- **The consent-gate suite no longer runs real `git` mutations against the repository.** The
  `ToolExecutor · 0.6.5 consent & push gates` tests execute approved commands for real via
  `execFile` with `cwd` = `workspaceFolders[0]`, which pointed `git commit -m x` / `git push
  origin main` at the extension's own checkout. A real `git commit` re-entered the pre-commit
  hook (compile + `npm test`) and hung the suite until mocha's 20 s timeout whenever the index
  was dirty; a real `git push` could reach `origin`. Those commands now run in a throwaway temp
  directory, pinned by a guard test that fails if the execution cwd is the repository.

### Maintenance
- **Removed two redundant config tests.** `configCanonicalKeys.test.ts` re-asserted two invariants already covered by `configSchema.test.ts` (`every catalog key is a canonical setting key` and `the host derives _allSettings from the canonical key list`); the duplicates were dropped and the `> 40 keys` full-catalog sanity check was folded into `configSchema.test.ts`.
- **Licensing metadata added — the project is now MIT.** It was publicly distributed
  (GitHub plus Marketplace `.vsix`) with no `LICENSE`, no `package.json` `"license"` field
  and no README licence section — effectively "all rights reserved". Added a canonical MIT
  `LICENSE`, set `"license": "MIT"` in `package.json`, and documented it in a README
  `## License` section. `src/test/suite/shared/licensing.test.ts` guards all three so the
  metadata cannot silently regress.
- **Removed `src/llm/providers/BaseProvider.ts`.** Its two strict-mode tool-schema
  helpers (`convertToolsForOpenAI`, `convertToolSchemaForOpenAI`) were verbatim
  Roo-Code code with **no callers**: nothing in the extension extends `BaseProvider`,
  and OpenAI tool payloads are built inline in `src/llm/providers/openai.ts`. Their
  only practical effect was to place the project under upstream's Apache-2.0
  obligations (patent grant plus per-file change notices). Deleting them — rather
  than rewriting code nothing calls — removes the derivation outright.
- **Reworded the last Roo-Code attribution comments** — the three file headers in
  `src/llm/tools/types.ts`, `src/llm/modes.ts` and `src/llm/prompts/system.ts`, plus two
  `Cline-style` CSS comments in `src/webview-ui/src/styles/app.css`. They now describe the
  in-house design or UI pattern instead of naming an upstream source. The source-hygiene
  suite below scans every file under `src/` (all extensions, not just `.ts`) and fails if
  any `Roo`/`Cline` attribution string reappears.
- **Regenerated the tracked webview bundle** (`webview-ui-dist/webview.js`, committed
  build output) so the artifact matches the reworded CSS. The production build is
  deterministic — a second run emitted byte-identical output and rewrote nothing — and
  the rebuild touches exactly one file: a single-line diff, with the other 70 tracked
  files left untouched. No `Cline` string remains anywhere in `webview-ui-dist/`.
- The one live export of that module, the `ContentBlockText` / `ContentBlockImage` /
  `ContentBlockParam` types, moved to `src/llm/types.ts`. The four type-only importers
  (`llm/providers/openai.ts`, `llm/providers/anthropic.ts`, `llm/context/tokenCounter.ts`,
  `webview/ChatViewProvider.ts`) now import from there.

  Behaviour is unchanged — tool schemas were already passed through verbatim, and the
  removed helpers were unreachable.

  Tests: `src/test/suite/llm/providers.test.ts` adds a source-hygiene guard that scans
  every file under `src/` — all extensions, production sources only — failing if the
  derived helpers or any `Roo`/`Cline` attribution reappears, and pins the OpenAI
  `chatWithTools` tool-payload contract, including that caller tool definitions are
  not mutated.

- **Packaging: `.github/**` and `.husky/**` are now excluded from the `.vsix`.** CI workflow
  definitions and Husky git hooks were shipping inside the published package. The
  `.vscodeignore` change drops the artifact from 110 to 91 files, with no runtime
  impact. Guarded by a new `src/test/suite/shared/packaging.test.ts`.

- **Open VSX publishing is now scripted — `npm run publish:open-vsx`.** `vsce` cannot
  publish to Eclipse Open VSX: it is a separate registry with its own CLI (`ovsx`), account
  and token. `scripts/publish-open-vsx.js` gates the run *before* invoking `ovsx` — a token
  is present, the `.vsix` exists, and its filename version matches `package.json` — so a
  misconfigured run fails locally instead of half-authenticating against the registry.
  `--verify-only` checks the token against the publisher namespace without uploading.
  Guarded by `src/test/suite/shared/publishOpenVsx.test.ts`.

- **The marketplace icon is a real PNG again.** `resources/icon.png` was a JPEG (JFIF)
  renamed to `.png` — 428 KB of mislabelled image that VS Code and Open VSX both
  advertise as a PNG. Converted to a genuine PNG and downscaled to 256x256 (91 KB, from
  1 MB). Guarded by `src/test/suite/shared/packaging.test.ts`, which asserts the PNG
  signature and IHDR dimensions.

## [0.7.1] - 2026-10-05

### Performance
- **Activation no longer loads the whole extension graph, or builds services it may never
  use.** Three changes, each measured with the interleaved A/B harness
  (`node scripts/bench-ab.js <entryA> <entryB> --activate`):
  - **P1 — the extension entry is bundled (esbuild).** It shipped as 156 unbundled CommonJS
    files; it is now a single `dist/extension.js` (`scripts/build.js`; 399 KB vs 1786 KB
    unbundled). Cold module load **129.5 ms → 41.9 ms** (median, 9 interleaved runs). `npm run compile` still
    type-checks, `npm run bundle` emits the runtime artifact, and `scripts/build.js` fails
    the build if the bundle ever requires anything but `vscode` + Node built-ins.
  - **P2 — I/O and process work is off the activation path.** `src/shared/deferredStartup.ts`
    queues the repository-understanding refresh and the MCP connect, draining them after
    `activate()` returns. `McpManager.ensureConnected()` connects lazily, so deferring the
    eager `connectAll()` cannot race first tool use.
  - **P3 — services are constructed on first use.** `createServices()` used to `new` all
    fourteen services during activation, so a session that only opened the work-item tree
    still paid for the chat stack, MCP manager and understanding cache. It now returns a
    lazily-materialised container built by `src/shared/lazyServices.ts`; each factory pulls
    in only the siblings it needs (`understanding` still receives the shared `git` +
    `workspaceMemory` instances).

  Startup is also cheaper to verify now: `npm run test:unit` runs the pure/shared suites
  headlessly (`scripts/vscode-stub.js` supplies the `vscode` API), so the laziness and
  deferred-startup contracts are asserted without a VS Code download.

  Tests: `src/test/suite/shared/lazyServices.test.ts`, `src/test/suite/services.lazy.test.ts`,
  `src/test/suite/shared/deferredStartup.test.ts`.

### Bug Fixes
- **A chat could mint a brand-new session id on every request.** Chat sessions were
  persisted under a key that folded in the *currently active* ADO project
  (`adoCode.sessions:<folder>:<project>` and `adoCode.activeSessionId:<folder>:<project>`),
  but `activeProject()` is not stable during a turn's lifetime — it is empty while the
  extension activates and then flips once the org resolves (org switch, work-item open,
  settings settle) — so the active-id lookup missed, `ensureSession()` saw `null`, and a
  fresh session started on every request. Session storage is now **folder-scoped only**
  (`ChatViewProvider.sessionKey` no longer includes the project); the project is recorded
  per session as a `Session.project` attribute for display and grouping. A one-time
  `migrateProjectScopedSessions()` pass folds existing project-scoped buckets into the
  folder bucket (deduped by id, newest active id carried over) so existing histories are
  preserved. Covered by `src/test/suite/webview/sessionScoping.test.ts`.
- **Outbound User-Agent reported a version that never shipped.** `EXTENSION_VERSION`
  (`src/shared/version.ts`) had drifted from `package.json`, so every LLM request on
  0.7.0 still announced `ADO-Code/0.6.7`, making provider/gateway logs wrong. The
  constant is now `0.7.0` and the two sources are kept in sync mechanically:
  `src/test/suite/shared/version.test.ts` asserts the invariant in the test suite,
  and `scripts/check-version.js` runs on `vsce package` (`vscode:prepublish`) and in
  the pre-commit hook, so a drift can neither merge nor ship.

- **Version drift is now blocked in CI, not just by local hooks.**
  `.github/workflows/version-check.yml` runs `check:version` as a status check on
  every PR and on pushes to `main` — a local hook can be skipped with `--no-verify`,
  a required check cannot. The job carries no `paths:` filter (a skipped workflow
  never reports a status, which would leave a required check pending forever) and
  includes a self-test that drifts the constant on purpose and asserts the gate
  exits non-zero, so a silently disabled gate cannot pass as coverage.


## [0.7.0] - 2026-10-01

### New Features
- **Queue vs. steer for mid-run input** (`adoCode.chat.inputWhileBusy`, default `steer`): choose what happens when you type while the AI is working. **Steer** injects your text into the *running* turn's next iteration so the agent folds the new instruction into the work in progress instead of stopping; **Queue** holds the message (rendered as a numbered pending chip with a per-item remove button) and sends it as the next turn once the current one finishes. Both behaviors show exactly what is pending: queued messages appear as removable chips, and steered messages appear in the thread with a `⚡ steering…` marker that flips to `⚡ steered into run` once the loop picks them up.
- **AI delegation suggestions** (`adoCode.chat.suggestDelegation`, default on): the assistant can recommend handing a coding task to an installed external agent, and the chat renders a compact suggestion card with **Delegate** (starts the run) and **Dismiss**. Turn the setting off to suppress the suggestion prompt entirely.
- **Chat density modes** (`adoCode.chat.density`, default `comfortable`): an explicit three-way control over the chat's per-turn detail. **Comfortable** (default) shows tool activity, reasoning and turn summaries; **Compact** keeps that detail with a tighter vertical rhythm; **Answers only** hides a completed turn's chrome — expand a single turn ("Show details") to reveal it on demand. Cycle modes from the kebab menu (`Chat density: …`) or set it in the Configuration page.

- **`View Archived Goals` affordance in the To-do view**: a toolbar toggle (`$(archive)` / `$(checklist)`) switches the view between the live list and a read-only history of the active session's superseded completed goals. Archived goals render as `archive` roots with their finished steps nested underneath (no checkboxes); the toolbar label/icon swaps with the mode via the `adoCode.todos.archiveMode` context key.

### Improvements
- **Steering is non-destructive**: steering a running turn no longer aborts it. The agentic loop drains buffered steer text at the top of every iteration (`runAgenticChat`'s new `drainSteering` hook), appends it as a `user` turn for the next round-trip, and persists it into the session conversation — so the agent course-corrects without losing the work already done.
- **Chat-area declutter — readability first**: long, tool-heavy turns no longer bury the answer under execution chrome.
  - **Tool calls fold into one activity row** (`Ran N tools ▸`): a turn's consecutive tool calls collapse into a single row that expands to the unchanged per-tool cards. The live / just-finished turn starts expanded so you still watch work land; historical turns stay collapsed.
  - **Reasoning is quiet text**: the boxed, blue-bordered "Thinking" block is replaced by dimmed, unbordered prose — no icon, label, or collapse toggle. Still gated entirely by `chat.showThinking`.
  - **Attachments render as chips** (`📎 3 files`, file names on hover): attached files are no longer re-serialized into the user bubble; the full file bodies still go to the model.
  - **Turn summary line** (`Ran 7 tools · 2 files edited`): a completed turn carries a one-line, count-based cost summary above its folded activity row, so a historical turn's scale is legible at a glance without expanding it. Counts are derived from the turn's trace only (no timing or token data is fabricated).
  - **Jump to latest + collapse-all** (declutter item 6): a floating `↓ Latest answer` pill appears once you scroll up from the newest message and hides when you're back at the bottom; the kebab menu gains a `Collapse all turns` / `Expand all turns` action that forces every turn's folded activity row open or closed.
  - **Transient status is one quiet line** (declutter item 7): the in-thread `Working…` headline and the per-tool running spinners collapse into a single low-contrast status line pinned above the input (e.g. `Working… · 2 tools running`); idle turns show nothing, and the durable tool cards stay in the thread.

- **Session-scoped To-do view**: the view now renders only the **active chat session's** goal and steps, so switching sessions resets the panel to that session's list (or the empty placeholder) instead of leaving another session's list behind.
- **Superseded goals are archived, not discarded**: when a new goal & to-do list is created for a session after the previous goal was fully completed, the old goal and its finished steps are moved to a per-session `archive/` store (still keyed to the session) so the history stays traceable. `set_goal` starts the successor from a clean live list; a goal that is not yet complete is still overwritten in place.
- **Archive lifecycle**: deleting a chat session removes its archive too (`removeSession`); the plain To-do `Clear` intentionally keeps the archive, and clearing everything (`removeAll`) wipes it as well.

- **One error banner, everywhere**: the Configuration page carried its own error banner *and* auto-dismiss timer — a second implementation of the chat view’s banner — purely because the page is rendered before the chat’s global banner mounts. Both now render one shared `ErrorBanner` component (`components/common/ErrorBanner.tsx`): host fetch/save failures on the Configuration page auto-dismiss on the same timeout and gain the ✕ dismiss control they previously lacked, and the page’s "Saved" flash timer is now cleared on unmount instead of firing into an unmounted component.

### Fixes
- **Switching sessions no longer aborts a running turn**: picking another session (the history dropdown, **New Session** or `/resume`) used to stop the in-flight response outright, so switching away mid-answer silently killed the work. The run is now *detached* instead: it keeps streaming into **its own** session buffer, persists when it finishes, and its live output is hidden only while that session is off-screen. Switching back re-arms the working spinner and the stream resumes where it is — the completed answer is always waiting in the session you left.
- **Warned before a background run is stopped**: sending a message in a *different* session while one is still generating is the only remaining way to kill it (a single LLM turn runs at a time), so it now asks first — *Stop it and send here* or *Keep it running (cancel)*, with the visible thread rolled back on cancel. Steer text typed in another session can no longer be injected into an unrelated run.
- **`/remember` now actually remembers**: it previously wrote to a workspace-keyed notes store nothing ever read, so remembered notes never reached the model. `/remember <text>` now persists a `preference` memory (the same store injected into the system prompt) and reports the new count; `/forget` clears that store and reports how many entries were removed.
- **Session name updates as soon as the topic is known**: a session created via **New Session** kept that placeholder label in the header and the history dropdown until you switched to another session and back — even though the first turn had already auto-named the session internally. Persisting a turn now pushes the refreshed session list to the webview, so the auto-assigned name (derived from the first user message, as it already was when you chat without clicking **New Session**) appears the moment the AI has processed the opening message, with no switch required.
- **Running badge in the session list**: a session that is still generating — including one still working in the background after you switched away — now shows a pulsing **Running** / **Background run** badge in the history dropdown, so detached work is visible at a glance instead of the session looking idle.

- **Enter works mid-turn, multi-line input stays readable, history stops auto-jumping**: three chat-view UX fixes. (1) `InputBar.handleSend` bailed out with `if (loading) return;`, so pressing Enter while a turn was running did nothing - even though the host already routes mid-turn messages as steer/queue instructions (`chat.inputWhileBusy`); the guard is gone so Enter steers/queues the live run. (2) A multi-line user message collapsed into a single visual line because the bubble's `<p>` used the default `white-space: normal`; the user bubble now uses `pre-wrap`. (3) Scrolling up into history no longer snaps back to the newest message when a new token or turn arrives - the chat area now tracks whether the reader is parked at the bottom (new pure `shouldAutoScroll` helper in `src/shared/chatNavigation.ts`) and only auto-scrolls while following, re-engaging when the reader sends a message or the thread is bulk-loaded. New regression guards: `chatInputMidTurn.test.ts`, `chatMessageStyles.test.ts`, plus `chatNavigation.test.ts` coverage of `shouldAutoScroll`.
- **Configuration page surfaces every contributed setting**: six settings declared in `package.json` (and honored by the extension) were missing from the Configuration UI, so they could only be set by hand-editing `settings.json` — `skillRegistryUrls`, `understanding.agentsMdSync`, `chat.inputWhileBusy`, `chat.suggestDelegation`, `agents.autoCompleteChildren`, and `agents.progressView`. They now render on the page, with a new **Skills** section for the skill-registry list.
- **Catalog-drift guardrail**: a new unit test (`configCatalog.test.ts`) fails the build whenever a contributed `adoCode.*` setting is not surfaced in the Configuration page (or not explicitly special-cased), so a newly added setting can no longer ship without a UI control.

### Tests
- New `shared/sessionRun` suite: turn/session visibility (live output only ever reaches the session that owns the run), detection of a still-running turn in *another* session, and the shared "still generating in …" notice copy (named session, unnamed/blank fallback).
- New `shared/sessionRun` `sessionRunInfo` cases: idle returns no badge, the on-screen session's run is reported as foreground, and a run owned by another session (or with no visible session) is reported as a background run with its own tooltip.
- New `runAgenticChat` steering suite: a steered message lands on the *next* iteration (not the current one), the run completes normally (not aborted), progress surfaces the steering for the UI badge, and steering before the first round-trip is honored immediately. Plus delegation-prompt and `extractDelegationSuggestion` unit tests.
- New `shared/toolActivity` and `shared/attachments` suites: folding consecutive tool calls into activity rows (`Ran N tools` labels + name previews), and extracting attachment names from both `[Attached: …]` markers and legacy `[File: …]` blocks (plus chip labels).
- New `shared/turnSummary` suite: count-based turn metrics (tool calls, reasoning blocks, distinct files edited including path-alias handling and dedupe) and the formatted one-line label (singular/plural, empty and reasoning-only turns).
- New `shared/chatNavigation` suite: the jump-to-latest visibility rule (thresholds, short content, non-finite inputs) plus the collapse/expand-all override resolution and its action label.
- New `shared/chatDensity` suite: mode normalization (whitespace/casing tolerance, unknown-value fallback to `comfortable`), the container class, chrome-hiding/density rules, per-turn chrome visibility, mode cycling, and the density/details labels.
- New `shared/transientStatus` suite: the status-line headline derivation (activity precedence, reasoning-aware `Working…`/`Reasoning…`, `Responding…`/`Thinking…`, idle collapse), running-tool counting (finished/hidden/malformed entries excluded), and the `· N tool(s) running` suffix formatting.
- New/updated `TodoStore` and `TodoTreeProvider` suites: archive-on-supersede, incomplete goals not archived, per-session archives, corrupt-archive tolerance, `removeSession` vs `remove` vs `removeAll`, session-switch reset, and the archive-view toggle/rendering.

### Internal
- **Single source for the model-capability heuristic**: the vision/tool inference logic was duplicated between the extension host (`src/llm/modelCapabilities.ts`) and the Configuration page, whose copy was kept in sync by hand under a "keep the patterns in sync" comment. The pure, VS Code-free module now lives in `src/shared/modelCapabilities.ts` and is imported by both sides; the host file is a thin `export *` barrel, so existing import sites are unchanged. A new test (`modelCapabilities.test.ts`) asserts the host barrel exposes the *same function object* as the shared module, so a second copy cannot silently reappear.
- **Webview re-exports shared host types**: the hand-mirrored `AgentName`/`AgentCapability`/`AgentRun` and `Skill*` type copies in `src/webview-ui/src/types.ts` are now re-exported from `src/agents/types` and `src/shared/skillTypes`. The webview project resolves `../../` paths (rootDir is the repo root), so the stale "the webview project can't resolve that path" note was removed.
- **Configuration page split into focused modules**: `ConfigurationPage.tsx` had grown to ~1250 lines mixing five concerns (settings catalog, collection inputs, model widgets, page shell, render dispatch). It is now a shell-only component (state, sidebar, save, render): the catalog moved to `src/webview-ui/src/components/config/catalog.ts` (pure data + types — no React, no vscode bridge), the collection inputs to `config/inputs/*` (`ArrayInput`, `McpServersInput`, `OrganizationsInput`, `CapabilityOverridesInput`) and the model widgets to `config/model/*` (`ModelInput`, `ModelFetcher`, `ModelCapabilitiesLine`, `ModeModelConfig`). Pure move — no behavior change; the page drops from 1231 to ~419 lines. A new test (`configModules.test.ts`) fails if the catalog or a field widget reappears in the page, and the `configCatalog` / `modelCapabilities` guards were retargeted to read the extracted modules.

- **Data-driven setting rendering; derived Advanced count**: the Configuration page's ~65-line `setting.type === … ? … : …` render chain is replaced by a `SETTING_RENDERERS` registry (`config/renderers.tsx`) — one component per `ConfigSetting['type']`, typed as an exhaustive `Record` so a new type is a compile error — and the page renders every row through a single `<SettingField>` dispatcher. The Advanced category's per-mode model rows now come from one `MODE_ROWS` list, and the sidebar badge count is derived from `ConfigCategory.extraRows` instead of the hand-maintained `extraCount: 4`, so adding a mode can no longer desync the badge. A new test (`configRenderers.test.ts`) asserts the registry is exhaustive, the page carries no type-dispatch chain, and the count stays derived; the Stage 2 guard (`configModules.test.ts`) was retargeted so the field widgets are now expected in `renderers.tsx`. The page drops from ~419 to ~310 lines.
- **`saveConfig` payload is validated; the settings map is typed**: the `saveConfig` handler wrote every key the page posted straight through `updateSettingRespectingScope`, so an unknown/typo'd key or a non-JSON value was a silent no-op. Inbound payloads now pass a dependency-free validator in `src/shared/configSchema.ts` (`CONFIG_SETTING_KEYS` + `parseSaveConfigPayload`): unknown keys and invalid values are logged and skipped, keeping the existing rule that one bad key never drops the rest. `_allSettings()` now returns a typed `ConfigSettingsMap` with a `readonly ConfigSettingKey[]` key array, so an unlisted or mistyped setting is a **compile error** (it immediately rejected the two untyped key writes). A new guard (`configSchema.test.ts`) cross-checks the validator against a `zod` schema used purely as a test oracle (zod stays a devDependency — the extension ships zero runtime dependencies, so it cannot run in the host) and fails whenever `package.json`, `_allSettings()` and the webview catalog disagree on the key set. That guard caught and fixed five settings the page rendered but the host never read (`chat.inputWhileBusy`, `chat.suggestDelegation`, `agents.autoCompleteChildren`, `agents.progressView`, `skillRegistryUrls`) — saving them would have written `undefined` over the real value.
- **One source for the webview ↔ host message contract**: the message unions and the shared domain types (`WebviewToExtensionMessage`, `ExtensionToWebviewMessage`, `ExtensionConfig`, `Session`, `TraceEntry`, `SessionRunInfo`, the work-item/attachment types) were declared twice — canonically in `src/shared/messages.ts` for the host, and again hand-mirrored in `src/webview-ui/src/types.ts` under a "the webview project cannot resolve cross-project imports" note that had been false ever since `src/shared/` existed. The webview file is now a thin re-export of the shared module (plus `src/shared/sessionRun.ts`), and the stale premise is gone. Reconciling the two copies surfaced real, invisible drift: the host was already posting `steeringQueued` / `steeringApplied` / `delegationSuggestion` / `sessionRunState` without its own union declaring them, `openProjectWizard` was declared in the wrong direction, `sessionList` was missing the `running` badge field the host sends (`ChatViewProvider.sendSessionList`), and `ExtensionConfig` omitted the three `chat.*` settings the page already read. A new test (`messageContract.test.ts`) pins the single-source invariant, the corrected union directions, the 0.6.x host→webview members, and the `sessionList.running` field.
- **Configuration page styles are co-located**: ~700 lines of `.config-*` rules moved out of the global `styles/app.css` into `src/webview-ui/src/components/config/styles.css` (mirroring `SkillCatalog/` and `ProjectCreationWizard/`); the chat-only `.model-capability-warning` rule that sat mid-block stayed behind in `app.css`, where its consumer (the chat view) lives. Two now-dead rules (`.config-error-banner`, `.config-error-text`) were dropped alongside the banner consolidation. New guards: `errorBanner.test.ts` (one banner owner; `ERROR_AUTO_DISMISS_MS` has exactly one runtime consumer) and `configStyles.test.ts` (config rules live only in the co-located file and are config-only).

- **Configuration contract hardening (R-series)**: three latent couplings in the Configuration UI were removed. **(1)** The page decided whether to render the Fetch-Models control and the capability readout by comparing `section.title` to a literal string, so renaming a display title silently dropped the control; sections now declare `showModelFetcher` / `showModelCapabilities` flags and the byte-identical duplicated `ModelFetcher` block was collapsed to one. **(2)** The settings catalog moved from `src/webview-ui/src/components/config/catalog.ts` to `src/config/catalog.ts` (it is pure data), so the host-side guards import it as real objects instead of regex-parsing source text, and `ConfigSetting.key` is now typed as `ConfigSettingKey` — a typo'd or un-contributed key is a **compile error**. The host's `_allSettings()` now iterates the canonical `CONFIG_SETTING_KEYS` list instead of keeping a byte-for-byte copy of it. **(3)** The config payload contract is symmetric — `fullConfig` was `Record<string, any>` while `saveConfig` was already `Record<string, unknown>`; both are now `unknown`, the page holds the typed `ConfigSettingsMap`, and `handleChange` keys are `ConfigSettingKey`. The welcome wizard's write path (`applyConfigUpdate(config: any)`, a fourth bare-string key mapping with no guard at all that threw on a null payload) now validates through a new pure, unit-tested `parseWizardConfigPayload` — unknown props ignored, non-JSON values dropped, non-object payloads rejected. New guards: `configSectionGating.test.ts`, `configCanonicalKeys.test.ts`, `configPayload.test.ts`.

## [0.6.7] - 2026-09-30

### New Features
- **Session To-do list and goal** (`To-do` view + `set_goal` / `update_todo_list` tools):
  - New **To-do** view in the ADO Code activity bar: one collapsible group per chat session that has a list (the active session sorts first and is marked `active`), each item rendered as a **checkbox** with a status icon. Groups show `completed/total` progress, and the view carries a badge counting the active session's outstanding items.
  - **Session goal.** Each session carries one objective — rendered as the **top node** of the To-do view (`$(target)` icon) with its to-do items nested underneath, so progress reads as "steps toward this goal". The AI records it with a new `set_goal` tool as soon as the objective is clear, and you can set, edit or clear it yourself with `/goal <objective>` in the chat (bare `/goal` opens the current value for editing, `/goal --clear` removes it) or via **Set Session Goal** / **Clear Session Goal** in the view toolbar and item context menu. The goal is deliberately stable: rewriting the steps never drops it (`update_todo_list` preserves it, `removeItem` keeps the file while a goal remains), and the tooltip records whether it was set by you or by the AI. The live goal is injected into the system prompt and returned with every list rewrite, so the model re-anchors on the objective instead of drifting into busywork.
  - The AI maintains the list itself through a new `update_todo_list` tool (TodoWrite semantics: the model sends the COMPLETE list every call, marking one item `in_progress` while it works and flipping it to `completed` the moment the step is actually done). `read_todo_list` returns the current list and goal. All three tools are available in **every** mode — including plan mode, where the goal and its plan *are* the planning output — and never raise a consent prompt, because the ledger only touches the extension's own metadata.
  - Lists are per session and persisted under `.ado-code/todos/<session>.json` (session ids are ISO timestamps, so the file name is a readable slug plus a short hash of the full id — unique and filesystem-safe). Deleting a session deletes its list; renaming one updates it; a session's file is deleted once its last item *and* its goal are gone — losing the last step never loses the objective it belonged to.
  - The user can also tick items by hand (the checkbox writes through the same store), add items from the view toolbar, mark items pending/completed, remove single items, and clear a session's list — all from the view title and item context menus.
  - Untrusted model input is normalized: unknown statuses degrade to `pending`, blank entries are dropped, duplicates collapse, both the item count (50) and each label (300 chars) are capped, and the goal is collapsed to one capped line. A corrupt or partially written file is skipped rather than breaking the tree.
  - New: `src/services/todo/TodoStore.ts` (persistence, normalization, rendering), `src/webview/TodoTreeProvider.ts` (the tree), and the `todo` tool group in `src/llm/modes.ts` / `src/llm/tools/types.ts`.

### Improvements
- **Workspace memory entries are readable and openable from the status panel**:
  - Memory keys under `.ado-code/memory/` previously rendered as opaque folder-like rows with no way to see their contents.
  - Each row now shows a parsed preview — the first content-bearing line of the `.md` file, with markdown syntax (headings, bullets, quotes, emphasis, links, YAML frontmatter) stripped.
  - Hovering a row renders the full document as markdown in the tooltip (capped at 4000 characters).
  - Clicking a row opens the backing `.md` file in an editor; the context menu adds **Open Memory File**, **Preview Memory (Markdown)** and **Copy Memory Content** (the open action is also an inline icon).
  - User memory rows get the same treatment: key label with `[category]` and a parsed preview in the description, full content in the markdown tooltip.
  - New pure helper `src/shared/markdownSummary.ts` (`summarizeMarkdown` / `stripMarkdown`) with unit tests.
- **Thinking & Tools record now survives a session reload**:
  - A finished turn's Thinking/Tools record (reasoning blocks interleaved with the tool cards they introduced) is now persisted with the session instead of living only in the open chat. Reopening a session — or restarting VS Code — renders the same record that produced each answer, instead of just the answer text.
  - Reasoning is stored as a capped excerpt (1200 chars per block), tool arguments and results are capped in place (600 / 1200 chars, every argument key preserved so a restored card shows the same one-line summary as a live card), and a whole turn is bounded at 32 KB — oldest segments are dropped first and the record is flagged as trimmed.
  - Restored reasoning renders **collapsed** with a one-line preview and a neutral border (historical context, not live reasoning); tool cards render intact with their completed/error state. Reasoning from the turn you just watched stays expanded.
  - The record is handed back to the host once per completed turn (`recordTurnTrace`) because only the webview knows the chronological interleaving; the host caps it, keys it to the answer it produced, and re-attaches it across re-persists, trims, and condensation.
- **Tool cards: completed calls never render as "running"**:
  - Card status now derives from the completion flag first, then result presence. A tool whose result is the empty string (a silent delete, a command with no output) previously kept a "running…" spinner and stayed expanded forever — the completion flag was populated but only consulted by the hidden-tools disclosure.
  - Argument summaries are shown in the collapsed card header (`read_file · src/llm/agentic.ts`), so a collapsed card is informative without expanding it; the tool card's inline styles moved to `app.css` and use the shared `Badge` component.
- **Reasoning can no longer be prepended to an answer**:
  - Every agentic iteration reports its text through the same progress callback, and the webview buffers every non-done assistant message into the reply. An iteration's pre-tool reasoning was therefore accumulated into the answer as a prefix (a three-iteration turn opened its answer with two runs of "Let me check…" text) whenever `chat.showThinking` was on.
  - The host now mirrors each pre-tool iteration text as `assistantMessage` with `isThinking: true`; the webview refuses to buffer flagged text. The text is still displayed by its own thinking block — the flag exists only to keep it out of the reply.
  - New assertion locks the `final` flag contract on the agentic progress callback: pre-tool text is non-final, the terminal answer is final, so intent is never inferred from event order.
  - `assistantMessage` gained the `isThinking` flag for text that is pre-tool reasoning and must never be buffered into the reply.
- **A streamed reasoning delta can no longer absorb the start of an answer**: reasoning that arrives after answer text has started now opens a new reasoning block instead of appending to the block that preceded the answer, which previously pulled the answer's opening tokens into the Thinking block.
- **Live turn header no longer repeats the block label**: when reasoning is already on screen the activity headline reads "Reasoning…" / "Working…" instead of a second "Thinking…" above a `Thinking` block.
- **Tests**: new suite for turn-trace persistence (capping, re-persist stability, restore round-trip, repeated-answer pairing).

## [0.6.6] - 2026-09-26

### Improvements
- **Per-org PAT support**: `adoCode.organizations` entries now accept an optional `pat?` field — a per-organization Personal Access Token that overrides the global `adoCode.adoPat` for that org. Documented in README settings table and in the `adoCode.organizations` schema.
- **Windows-safe temp-directory cleanup (`cleanTempDir`)**: New test utility `src/test/suite/utils/cleanTempDir.ts` replaces bare `fs.rmSync` calls in four test suites (`gitService`, `mergeCleanup`, `mergeConflicts`, `projectCreation`). On Windows it first runs `git gc --prune=now` to release Git object locks, then clears read-only attributes via `attrib -R /S /D`, and finally deletes recursively — eliminating the EPERM failures that caused intermittent test teardown errors on Windows.
- **Claude adapter Windows shim resolution**: Added `resolveBin(name)` helper to `ClaudeAdapter` that walks `PATH` and prefers `claude.cmd` (npm shim) over `claude.exe` over the bare name on Windows, matching the behaviour of the agent registry's detection. `runTask` and `resumeTask` now call `run.bin ?? resolveBin('claude')` instead of hard-coding the bare name, so delegation no longer fails with ENOENT on Windows npm installations.
- **Release notes moved out of README**: The `## Release Notes` section in `README.md` has been replaced with a link to `CHANGELOG.md` — all version history now lives exclusively in this file.

- **Token counting & context budgeting overhaul**:
  - **Overhead-aware context truncation**: Fixed `ContextManager.truncateMessages` to budget against `maxTokens - overheadTokens` rather than `maxTokens` alone. Prevents context window overflow crashes when large system prompts, Repository Understanding, or tool schemas push the total request beyond the model's limit.
  - **Anthropic native token counting fix**: Extracted and unified `formatAnthropicMessages` to translate `role: 'tool'` into native `tool_result` blocks inside user turns and assistant tool calls into `tool_use` blocks. Eliminates silent HTTP 400 Bad Request failures on `/v1/messages/count_tokens` during agentic turns with tool results, and passes tool schemas directly for exact API counting.
  - **OpenAI reasoning model protection**: Added a guard in `OpenAiProvider.countTokens` to gracefully bypass reasoning models (`o1`, `o3-mini`, `o1-mini`) without issuing synchronous `max_tokens: 1` completion requests, preventing API errors and avoiding wasted inference quota.
  - **Longest-prefix & delimiter boundary model matching**: `estimateContextWindow` now sorts known models by length descending and checks word boundaries, eliminating prefix collision bugs (e.g. `o1-mini` incorrectly assigned 200k tokens instead of 128k, or unrelated models containing `o1` falsely matching).
  - **Accurate CJK & dense code token weighting**: Separated ASCII punctuation from non-Latin scripts in heuristic counting. CJK characters are now weighted at ~1.5 tokens/char instead of being misclassified as code symbols at 3.5 chars/token (eliminating 400-500% undercounts), and dense code/JSON symbols use an updated ~2.8 chars/token ratio.
  - **Dynamic token-density ratio in tool output truncation**: `capToolResult` now calculates character boundaries from the content's actual chars-per-token ratio instead of assuming a flat 4 chars/token, ensuring capped tool outputs do not overshoot the 4,000-token limit.
- **Dedicated workspace `delete_file` tool**:
  - Added native, cross-platform `delete_file` mutating tool with workspace path confinement (`resolveWorkspacePath`), recursive directory deletion support, automatic pre-mutation checkpointing (`__auto__`), and in-turn read cache invalidation.
  - Allows AI models to cleanly remove temporary files and scratch directories without relying on shell scripts or terminal command workarounds.
- **Quote-aware shell operator sanitization**:
  - Enhanced terminal command operator check (`hasUnquotedShellOperators`) to strip single- and double-quoted string literals before inspecting for dangerous shell operators (`&`, `|`, `;`, `` ` ``, `$`, `<`, `>`, `(`, `)`, `\r`, `\n`).
  - Allows commands with legitimate parentheses, semicolons, and symbols inside quoted literals (such as `git commit -m "feat(scope): msg (comment); more"` and `node -e "..."`) to run without being falsely blocked.
- **Windows `cmd.exe` builtin command routing**:
  - Added automatic routing for Windows `cmd.exe` builtins (`del`, `erase`, `dir`, `rmdir`, `rd`, `copy`, `move`, `type`, `cls`) to spawn via `process.env.ComSpec || 'cmd.exe'` with `/d /s /c` and `windowsVerbatimArguments: true`.
  - Fixes `spawn del ENOENT` errors on Windows where internal shell commands lack standalone executables in `PATH`.
- **Degenerate tool loop detection & circuit breaker**:
  - Added `ToolLoopDetector` to prevent agentic chat turns from getting trapped in repetitive or infinite tool execution loops that waste context tokens and iteration budgets.
  - Identical tool call detection:
    - Normal execution on 1st and 2nd calls with identical signatures.
    - Warns on 3rd repetition with an in-context warning (`[loop warning]`) instructing the model to synthesize findings.
    - Blocks execution on 4th+ repetition (`[loop detected — call blocked]`), returning a guidance message to conclude or take an alternative step using context already available.
  - Overlapping `read_file` detection: tracks sequential line ranges read on the same file, issuing a warning after 2 overlapping reads and blocking after 3.
  - Circuit breaker: when consecutive iterations have all tool calls blocked by the loop detector, execution terminates early with a forced concluding reply explaining that a repetitive tool loop was detected.
- **Regex parsing with inline flags & `flags` parameter in `search_files`**:
  - Added `parseSearchRegex` to sanitize and handle regex search patterns emitted by LLMs.
  - Automatically detects, strips, and translates inline regex flags (e.g. `(?i)`, `(?m)`, `(?s)`, `(?ims)`) into valid JavaScript `RegExp` flags.
  - Supports unwrapping inline flag groups such as `(?i:pattern)` without breaking pattern compilation.
  - Added optional `flags` parameter to `search_files` tool schema for explicit flag passing (e.g. `"i"`).
  - Provides helpful error feedback indicating that the JavaScript RegExp engine is used if an invalid pattern is provided.
- **Collapsible, dismissible, and session-isolated confirmation cards**:
  - **Session isolation**: Confirmation requests are stored per session (`confirmationsBySession`), ensuring pending confirmation cards remain strictly isolated to their originating session and do not leak or misroute when switching sessions.
  - **Minimize / expand**: Added a toggle button (`−` / `+`) to confirmation card headers showing an option count badge (`(N options)`). Clicking the header expands the options back to full view.
  - **Dismiss / Close button**: Added a close button (`✕`) to confirmation card headers allowing prompt dismissal or cancellation.
- **Batch `read_file` via `paths` & elevated 400-line window**:
  - `read_file` now supports reading up to 10 files in a single tool call via the `paths` array, returning demarcated sections (`=== <path> (<N> lines) ===`) with per-file error resilience so invalid paths don't fail the rest of the batch.
  - Increased default read window from 200 to 400 lines (`MAX_READ_FILE_LINES = 400`). Files with 400 lines or fewer are returned in full without truncation banners; larger files return the first 400 lines with clear line-range guidance.
  - Dynamic system prompts and tool guidelines updated to instruct the AI to read small/medium files (< 400 lines) in a single whole-file call rather than slicing into micro-ranges, and to batch multi-file reads via `paths`.
- **Turn-scoped file read cache**:
  - Tool executor introduces `turnFileCache` to cache file reads in memory during a turn, eliminating repeated filesystem I/O when the model references the same files across iterations.
  - Automatically invalidated on file mutations (`write_to_file`, `edit_file`, `apply_diff`, `restore_checkpoint`) and reset at the beginning of each turn (`beginTurn()`).
- **`list_workspace` file size details**:
  - Added optional `details: boolean` parameter to `list_workspace` returning an array of `{ path, bytes }` objects for up to 150 files to assist codebase layout understanding.
- **Header menus and commands**:
  - Added dedicated VS Code commands `adoCode.rerunWizard` and `adoCode.openSettings` accessible via the Command Palette.
  - Added a "Refresh Work Items" action (`$(refresh)`) to the Work Items tab view title toolbar for direct access alongside work item actions.
- **Move chat into Editor Area & return to sidebar**:
  - Added option to open the chat interface in the main editor area as a tab via the chat view title action button (`$(link-external)`) or the chat kebab menu (`⋯` → "Move chat into Editor Area").
  - Seamlessly return chat back to where it was before:
    - Click the editor title bar action button (`$(layout-sidebar-left)` "Return Chat to Side Bar") on the editor tab.
    - Click "Return Chat to Side Bar" in the sidebar view placeholder or the in-webview kebab menu (`⋯` → `↙️`).
    - Close the editor tab (`✕`), which automatically restores and focuses the chat in the sidebar without losing conversation history, session state, or drafts.
- **Interactive Mermaid chart rendering**:
  - Full support for Mermaid diagrams (flowcharts, sequence diagrams, class diagrams, state diagrams, ER diagrams, Gantt charts, etc.) across the Chat interface, in-webview Task Details (`TaskDetailPanel`), full Work Item Details (`WorkItemDetailPanel`), and Agent Run Summaries (`AgentSummaryPanel`).
  - Interactive toggle button (`[ 📊 Diagram | </> Code ]`) allowing instant switching between the rendered visual diagram and the formatted Mermaid source code.
  - One-click copy button (`📋 Copy Code`) to copy raw Mermaid source directly to clipboard.
  - Theme-adaptive rendering automatically matching VS Code light, dark, and high-contrast themes.
  - Safe error recovery displaying syntax error banners with fallback to code view if incomplete or invalid Mermaid syntax is provided.
- **Export & copy Mermaid charts as SVG**:
  - Added "Save SVG" button (`💾 Save SVG`) to Mermaid diagram toolbars across Chat, Work Item Details, and Agent Run Summaries. Prompts a native VS Code file save dialog with auto-detected diagram title, sanitized filename, and standard XML declaration headers (`<?xml version="1.0" encoding="UTF-8"?>`), with browser download fallback.
  - Added "Copy SVG" button (`🖼️ Copy SVG`) to copy rendered SVG markup directly to clipboard.
- **Extension branding and Activity Bar icons**:
  - Contributed custom extension icon (`resources/icon.png`) and dedicated Activity Bar view container icons (`resources/activitybar-icon.svg`) for the primary (`adoCode`) and secondary (`adoCodeSecondary`) activity bar views, replacing generic comment icons.
  - Chat editor panel displays custom activity bar icon.
- **Unattached project option & standalone mode**:
  - Added a `None (no project)` choice to the chat header project dropdown for working independently without attaching to an Azure DevOps project.
  - Supports two primary workflows:
    1. Working when ADO connectivity is not yet configured or skipped — the project dropdown remains visible and interactive, displaying `None (no project)`.
    2. Working independently from ADO while still utilizing the assistant, agents, planning, and coding tools without binding to a project or work item.
  - Switching to `None (no project)` clears stored project bindings in workspace state and empties work items from the chat and sidebar tree without displaying missing-credential warnings or warning popups.
  - When ADO organization and PAT are configured, projects are auto-fetched in the background so you can re-attach to any project at any time from the dropdown, while keeping the "Azure DevOps isn't configured" banner hidden.
  - Updated the setup wizard (`WelcomeScreen`) to offer `None (no project)` as the default initial select option.

## [0.6.5] - 2026-09-08

### Improvements
- **Every LLM request carries a user-agent**: All provider calls (OpenAI-compatible and Anthropic: chat, tool calls, native token counts, /models fetches) now send `User-Agent: ADO-Code/0.6.5 (+https://github.com/steelburn/ado-code)` so gateway/provider logs identify ADO Code traffic
- **"Review Task Detail" is now an AI review**: Right-click a work item → Review Task Detail no longer only opens the detail — it binds the item to the chat and hands it to the AI, which reviews clarity/completeness, risks, dependencies, suggested approach, and whether the task is ready to start. The review runs as a normal chat turn (same system-prompt/tool pipeline; it may read the repo to ground the review but never mutates anything on its own) and streams into the chat next to the detail panel
- **One work item per session**: Sessions now remember which ADO work items they processed and show them as #chips in the session-history dropdown. When a session that already worked on another item is asked to process a DIFFERENT work item, ADO Code alerts the user and recommends a separate session per work item — with one-click Start a New Session / Stay / Cancel (cancel aborts the action before any ADO state change, branch creation, or delegation happens)
- **Work-item hover shows the ID**: Work-item tree tooltips now open with `#<id> · <title>` in addition to the existing type/state/assignment details
- **Command palette refreshed**: Every contributed command now carries the ADO Code category and clearer titles ("Change Work Item State", "Reconnect MCP Server", "Copy Agent Run ID", "Check Work Item Replies", …) so the palette reads consistently
- **Auto-approve harmless commands runs instantly**: With `adoCode.consent.harmlessAutoApprove` on, read-only terminal commands (git status/diff/log, npm test, ls, grep, …) now execute IMMEDIATELY — no consent card, no countdown timer (the old timed countdown is gone, along with the now-meaningless `consent.harmlessAutoApproveSeconds` setting). Off = harmless commands ask like any other mutating tool
- **Iteration budget defaults to 100**: `adoCode.act.toolBudget` (Iteration budget) now defaults to 100 with the recommendation "100+" — this extension drives large repositories where deep multi-step agentic turns are the norm (the Configuration page allows up to 1000)
- **Model pickers are dropdowns in Configuration → Advanced**: Opening the Configuration page auto-fetches the provider's model list when LLM credentials are saved, so the main model field, the Advanced per-mode model rows, the choice-detection model, and **Model Capability Overrides** rows all render as dropdowns (with a "type a custom model" escape hatch, and Refresh buttons inside Advanced) instead of bare text fields that only appeared once you manually fetched elsewhere
- **Token counting includes tool + image content**: The local heuristic counter now charges for every block actually passed to the LLM — tool-call argument JSON on assistant messages, tool-result payloads, and image blocks (size-based estimate), instead of counting text only. The host also sizes its truncation and status-bar overhead from the REAL system prompt (memory + understanding + work-item context) rather than a fixed estimate, so context decisions reflect true per-request cost
- **YOLO still asks before pushing**: Pushing code to the remote repository — the `push_worktree` tool OR a terminal `git push` — now requires approval even in YOLO mode. New `adoCode.yolo.pushApproval` setting, default **true** (approval required); disable it for full autonomy

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

