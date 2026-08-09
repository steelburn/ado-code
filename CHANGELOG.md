# Changelog

All notable changes to ADO Code will be documented in this file.

## [0.5.8] - 2026-08-10

### Features
- **Express/Advanced Configuration**: New configuration mode toggle in the Configuration page — Express (default) uses one model for all modes, Advanced enables per-mode model selection and reasoning effort tuning (low/medium/high) for reasoning models like o1/o3. New settings: `adoCode.advancedConfig`, `adoCode.llm.modeConfigs`, `adoCode.llm.modeReasoningEffort`

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
