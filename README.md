# ADO Code

AI coding assistant with Azure DevOps work item integration for VS Code.

## Features

- Fetch work items assigned to you from Azure DevOps (My Work Items + Unassigned trees, hierarchical Epic → Feature → User Story → Task)
- AI chat assistant with OpenAI-compatible and Anthropic-compatible LLM support
- Tool calling with agentic loop for autonomous coding tasks (Chat/Plan/Act/YOLO modes) — independent tool calls run in parallel, batched `edit_file` edits, and a `search_files` grep tool with per-line truncation
- Git-based task workflow: auto-create branch on pickup, update CHANGELOG.md on completion
- External agent orchestration (Claude Code, Codex, OpenCode, Hermes, Pi, and more)
- **Git worktree isolation**: Concurrent agents run in isolated worktrees — no branch conflicts
- **Worktrees view**: Dedicated sidebar tree with per-worktree details — run status, agent, dirty/clean files, last commit, ahead/behind — plus Open in Terminal/Explorer, Remove, and Show Agent Output actions
- **Reopen agent output**: Finished runs keep a "↗ Reopen" button and right-click → **Show Agent Output** — the summary panel is never permanently lost after being closed
- **Memory-driven agent hooks**: Workspace memory keys `agent.before` / `agent.after` run shell commands around every agent invocation; user + workspace memory are injected into every agent handoff prompt
- **Model capability checking**: Image paste/attach is disabled for non-vision models, models without tool calling are flagged, and the Configuration page shows a live capability readout. Detection is three layers — per-model **overrides** (you declare it, it wins) > **live gateway data** (OpenRouter/Ollama capability fields on `/models`) > **name heuristic** (gpt-4o/5, claude, gemini, o1–o9, llama-4, …)
- **Capability overrides**: `adoCode.llm.capabilityOverrides` declares vision/tool support per model id when auto-detection gets it wrong — edited as structured rows in the Configuration page, beating every other detection layer
- Multi-agent output panels: track multiple agent runs simultaneously with independent streaming output
- File checkpoints: auto-save before AI edits, restore on demand
- MCP (Model Context Protocol) support for external tool servers
- Slash commands with autocomplete (/help, /status, /clear, /mode, /delegate, …)
- User memory: AI remembers your preferences across sessions
- Workspace memory: project-specific conventions in `.ado-code/memory/` — kept out of git/Docker via auto-ignore
- **`.ado-code` auto-ignore**: The workspace data directory is offered to be added to `.gitignore`/`.dockerignore` on load (setting `adoCode.ignore.dotAdoCode`, default on)
- Direct mode selection: click Chat/Plan/Act/YOLO to switch modes instantly
- In-chat confirmation cards: task start, mode switch, and other prompts render as styled cards inside the chat
- **AI choice detection**: When the AI asks you to choose, options appear as clickable buttons — clicking one sends the option as a follow-up message; natural-language offers ("Want me to …?") are parsed via an optional cheap model (`adoCode.llm.choiceDetectionModel`), and long options stack as full-width rows
- **Reorganized Configuration UI**: Settings are grouped into navigable sidebar categories — Connection, AI & Modes, Permissions, Workflow, and Integrations — each with a setting-count badge, so you can jump straight to what you need instead of scrolling. The Advanced toggle gates a dedicated **Advanced** category: per-mode model selection, capability overrides, the choice detection model, and native token counting
- **Project Creation Wizard**: Multi-step UI for creating new projects with 9 templates (Node.js, Python, React, Next.js, Laravel, .NET) — configure options, ADO integration, and git setup before creation (`/new-project`)
- **Skill Management System**: Browse, install, and manage reusable AI skills — 10 built-in skills (Code Review, Documentation, Testing, Refactoring, Security Audit, Performance Profiler, Deployment Checklist, Database Schema Review, Accessibility Audit) with search, filtering, and enable/disable toggle (`/skills`)
- **AI skill execution**: The AI can discover and use enabled skills during conversations via the `execute_skill` tool — "Execute in Chat" button injects the skill prompt and triggers the LLM
- **Skill import**: Import custom skills from local .json files, SKILL.md files (YAML frontmatter + markdown), or .tar.gz/.zip archives — imported skills persist across VS Code restarts
- **Send Selection to Chat**: Right-click selected text in the editor → "ADO Code: Send Selection to Chat" inserts it as a fenced code block in the chat draft
- **Send File to Chat**: Right-click a file in the Explorer → "ADO Code: Send File to Chat" attaches it as a chip above the input bar with full content ready to send
- **Delete All Sessions**: `/clear-sessions` slash command + "🗑️ Delete All Sessions" in session history and kebab menu — wipes all sessions after in-chat confirmation
- **Confirmation cards for destructive operations**: Single session delete and delete-all show in-chat confirmation cards with danger styling instead of silently executing
- **Categorized `/help`**: Help output is grouped into Work Items, Chat, AI, and Other sections with autocomplete tip
- **AI merge flow**: For finished agent runs, the assistant can commit, push, and open an ADO pull request itself (`commit_worktree` → `push_worktree` → `create_pull_request`) — never force-pushes, never touches protected branches (`adoCode.git.protectedBranches`, default `main`/`master`), refuses to commit failed runs unless it explicitly overrides after reviewing, and can resolve merge conflicts (`resolve_pr_conflicts`) then re-commit/re-push until the PR is clean
- **Dynamic context window detection**: Context window size auto-detected from the `/models` API endpoint (Ollama `n_ctx`, OpenRouter `context_length`, etc.) — live data overrides the hardcoded table; content-aware token counting (code ~3.5, prose ~4.5 chars/token) with expanded model table (27 models) and 128k default
- **Context management**: Priority-based conversation truncation replaces naive 20-turn cutoff; real token counter replaces rough char/4 estimation; conversation auto-condenses at 75% context via LLM summarization; token status bar shows accurate model-aware counts
- **Mode-aware system prompt**: Dynamic prompt generation includes mode-specific role, available tools, tool guidelines, and environment context
- **MCP server management**: Right-click MCP servers in the Status Panel to disconnect, reconnect, or view details
Mode quick-cycle: Right-click the Mode item in the Status Panel to cycle through inline/plan/act/yolo
- **Worktree batch cleanup**: Remove All Completed action on the Worktrees root node
- **Agent run history**: Recent Runs section in the Status Panel shows last 10 completed runs with status icons, timestamps, and context menus
- **Agent details panel**: Right-click agent in Status Panel to view name, binary, version, supported modes, and CLI arguments
- **Memory search**: QuickPick fuzzy search across all user and workspace memory entries
- **Memory import/export**: Export memories to JSON; import with merge or replace option
- **Work item filtering**: Filter Work Items tree by state, type, or text search with smart parent visibility
- **Agent auto-review**: Git diff automatically reviewed by LLM on agent completion with merge recommendation
- **Worktree diff viewer**: Show Changes opens VS Code diff editor for worktree files
- **Generate tasks from user stories**: `/generate-tasks` slash command + context menu action trigger the AI to analyze a user story and create child tasks via the `create_work_item` LLM tool — **with duplicate prevention** (checks for existing child items before creating)
- **Task draft editor**: When the AI calls `create_work_item`, an editable markdown tab opens for you to review and modify all fields before the work item is created in ADO — **markdown content is automatically converted to HTML** for proper rendering in ADO
- **Child task delegation**: When delegating a work item to an agent, the system checks for child work items in ADO and warns the user — include them in the agent's context or skip them
- **Agent progress in chat**: Agent delegation shows start/completion messages in the chat thread alongside the streaming output panel
- **Changelog notification on update**: After a version change, a one-time notification offers to show the new version's changelog in a styled webview panel
- **Keyboard shortcuts**: Ctrl+Shift+M (cycle mode), Ctrl+Shift+/ (search memories), Ctrl+Alt+R (refresh status)
- **Clean Up After Merge**: Removes a merged run's worktree and deletes its branch (only when the PR is actually merged and the branch is fully merged) — from the Worktrees view context menu or an auto-offer after a merged PR
- **Working indicator**: A status-bar spinner shows while any LLM turn or agent run is in flight — visible even when the chat view is hidden, with live detail ("thinking…", "tool: edit_file")
- Full detail view: right-click → "Show Full Details" opens a formatted panel in the editor
- **Work item selection**: Selected items show a green badge; deselect via the row context menu
- Agent delegation injects AGENTS.md project context so all agents understand the codebase
- **Agent summary panel**: Completion summaries open in a styled HTML panel with metadata and duration
- Workspace scaffolding: new project wizard for Node.js, Python, PHP (Laravel), .NET C# with auto-generated files
- Workspace-to-ADO project binding: prevents working on items from the wrong project

## Requirements

- VS Code 1.85.0+
- Node.js 18+
- A git-enabled workspace folder
- Azure DevOps PAT (Personal Access Token) with `vso.work_write` scope
- An LLM API key (OpenAI-compatible or Anthropic)

## Extension Settings

Configure in VS Code settings under `adoCode.*`. The **Configuration page** organizes these into sidebar categories, each with a setting-count badge:

- **Connection** — Azure DevOps + LLM Provider
- **AI & Modes** — Mode, Act Mode, Chat, Sessions
- **Permissions** — Consent
- **Workflow** — Git, Changelog, Work Items, Workspace
- **Integrations** — Agents + MCP Servers
- **Advanced** — gated by the Advanced Configuration toggle; holds per-mode model selection, capability overrides, choice detection model, and native token counting (toggling it on jumps straight there)

The **Advanced Configuration** toggle in the sidebar enables the Advanced category for per-mode model selection and reasoning effort tuning.

| Setting | Description |
|---------|-------------|
| `adoCode.organizations` | ADO organizations (array of `{ name, url, project }`) |
| `adoCode.adoOrganization` | Active Azure DevOps organization name |
| `adoCode.adoProject` | Active Azure DevOps project name |
| `adoCode.adoServerUrl` | Optional on-prem ADO Server (TFS) base URL — empty = cloud |
| `adoCode.adoPat` | Personal Access Token |
| `adoCode.ado.clarificationState` | State set when clarification is requested |
| `adoCode.ado.warnOnSparseTask` | Warn before starting tasks with no description/AC |
| `adoCode.llmProvider` | `openai` (default) or `anthropic` |
| `adoCode.llmApiUrl` | LLM API endpoint |
| `adoCode.llmApiKey` | LLM API key |
| `adoCode.llmModel` | LLM model name (used for all modes in Express mode) |
| `adoCode.llm.choiceDetectionModel` | Optional cheaper model for AI choice-prompt detection (empty = main model, `off` = regex-only) |
| `adoCode.llm.capabilityOverrides` | Per-model capability overrides (array of `{ model, vision?, tools? }`) — beats auto-detection |
| `adoCode.advancedConfig` | Enable Advanced Configuration mode for per-mode model selection (default `false`) |
| `adoCode.llm.modeConfigs` | Per-mode model overrides in Advanced mode: `{ "inline": { "model": "gpt-4o" }, "act": { "model": "o3" } }` |
| `adoCode.llm.modeReasoningEffort` | Per-mode reasoning effort for reasoning models: `{ "inline": "low", "act": "high" }` — values: `low`, `medium`, `high` |
| `adoCode.llm.useNativeTokenCounting` | Use provider-native token counting (Anthropic count_tokens; OpenAI-compatible usage.prompt_tokens) for status-bar accuracy (default `true`) |
| `adoCode.mode` | Tool-use mode: `inline`, `plan`, `act`, or `yolo` |
| `adoCode.act.toolBudget` | Max tool calls per act-mode turn |
| `adoCode.act.terminalAllowlist` | Allowed command prefixes in act mode |
| `adoCode.consent.harmlessAutoApprove` | Auto-approve harmless (read-only) terminal commands after a timer (default `false`) |
| `adoCode.consent.harmlessAutoApproveSeconds` | Seconds before a harmless command auto-approves (default `20`, range 1–30) |
| `adoCode.consent.autoApproveTools` | Tool names or glob patterns (`read_*`, `get_*`, `edit_file`) that skip the consent prompt in inline/act modes (default `[]`) |
| `adoCode.chat.showThinking` | Show the model's thinking/reasoning text while it processes (default `true`) |
| `adoCode.chat.showToolCalls` | Show live tool-call cards in the chat while the AI works (default `true`; off shows only a pulsing "…" indicator) |
| `adoCode.git.requireGitRepo` | Block task pickup outside a git repo |
| `adoCode.git.createBranchOnTaskStart` | Auto-create `feature/ADO-<id>-<slug>` branch |
| `adoCode.git.requireCleanTree` | Warn on branch switch with uncommitted changes |
| `adoCode.git.prOnCompletion` | Offer to push + create a PR via `gh` on task done |
| `adoCode.git.protectedBranches` | Branches `create_pull_request` refuses to target (default `["main", "master"]`) |
| `adoCode.changelog.enabled` | Update CHANGELOG.md on task completion |
| `adoCode.changelog.autoCommit` | Commit CHANGELOG.md automatically |
| `adoCode.changelog.postToAdo` | Post the changelog entry as an ADO comment |
| `adoCode.ignore.dotAdoCode` | Offer to add `.ado-code` to `.gitignore`/`.dockerignore` (default `true`) |
| `adoCode.sessions.maxPerProject` | Max chat sessions kept per workspace + project |
| `adoCode.agents.enabled` | Which external agents may be delegated to |
| `adoCode.agents.verifyCommand` | Shell command run after an agent finishes |
| `adoCode.agents.autoSelect` | Default agent when none is specified |
| `adoCode.agents.autoReview` | Auto-review agent changes via LLM when a run completes (default `true`) |
| `adoCode.mcp.servers` | MCP server configurations (array of `{ name, command, args?, env?, timeout? }`) |

## Slash Commands

Type `/` in the chat input to see available commands:

| Command | Description |
|---------|-------------|
| `/status <state>` | Set work item state (e.g. Active, Done, Closed, Removed) |
| `/comment <text>` | Post a comment to the active work item discussion thread |
| `/pick` | Browse and select a work item from the tree to set as active context |
| `/assign <who>` | Assign the active work item to a team member (name or email) |
| `/clear` | Clear all chat messages and start fresh |
| `/clear-sessions` | Delete all chat sessions and start completely fresh |
| `/mode [mode]` | Switch tool mode: inline (ask), plan (read-only), act (auto-approve), or yolo (full autonomy) — omit mode to pick from list |
| `/undo` | Revert the last state change made to the active work item |
| `/help` | List all available slash commands with usage examples |
| `/delegate [agent] <prompt>` | Hand off the active task to an external agent (claude, codex, opencode, hermes, pi, gemini) |
| `/generate-tasks` | Generate child tasks for the active user story (review in editor before saving) |
| `/new-project` | Open the project creation wizard to create a new project |
| `/skills` | Open the skill catalog to browse and manage AI skills |
| `/resume` | Switch to a previous chat session to continue where you left off |
| `/remember <what>` | Store a preference or instruction the AI will remember across sessions |
| `/forget` | Remove all saved notes and preferences |

## Memory System

### User Memory

AI remembers your preferences across all sessions:

- "Remember that I prefer conventional commits"
- "Don't use var, only let/const"
- Use `/remember` and `/forget` commands

### Workspace Memory

Project-specific conventions in `.ado-code/memory/`:

- `conventions.md` — Coding style, naming patterns
- `architecture.md` — Design decisions, rationale
- `gotchas.md` — Known pitfalls, workarounds
- `custom.md` — Anything else project-specific
- `agent.before.md` / `agent.after.md` — **Agent hooks**: shell commands run automatically before/after every agent invocation (e.g. `npm ci && npm run lint` before, `npm test` after). Output streams to the run panel / is captured into the summary

Memory is injected into the chat assistant's system prompt and into every external-agent handoff prompt ("ADO Code Memory (instructions you MUST honor)"); the executable hook keys are excluded so agents don't re-run them.

`.ado-code/` is per-user, machine-local state — the extension offers to add it to `.gitignore` and `.dockerignore` on load (see `adoCode.ignore.dotAdoCode`). To share conventions with your team, prefer documenting them in `AGENTS.md`.

## Agent Worktrees

Each delegated agent run gets an isolated git worktree under `.ado-code/worktrees/`:

- The **Worktrees** view (ADO Code activity bar) lists every worktree with its run status (running/succeeded/failed/interrupted), branch, dirty/clean files, last commit, and ahead/behind
- Right-click actions: **Open in Terminal**, **Open in Explorer**, **Commit & Push**, **Remove**, **Show Agent Output**
- Branches are named from the ADO work item subject, e.g. `feature/ADO-42-fix-login-bug`
- **Merge flow**: after a run finishes, commit its changes (`Commit & Push` or the AI's `commit_worktree`/`push_worktree` tools), then open a PR (`create_pull_request`) — the AI is instructed to execute this flow and will stop and report if a step fails
- **Guardrails**: two agents can never run on the same work item concurrently; reusing a stale branch warns; **Remove** refuses silently discarding dirty work (offers *Commit & Push, then Remove*) and deletes the local branch afterwards only when it is fully merged — commits are never lost

## Model Capabilities

The extension infers the active model's capabilities from its id:

- **Vision**: models without image support get the chat's image paste/attach disabled
- **Tool calling**: models without it show a persistent warning that agentic modes degrade to plain chat
- The Configuration page shows a live readout ("Capabilities: vision · tool calling") for the selected model and highlights models lacking tool calling

## Release Notes

### 0.6.1

- **Proper tree structure for My Work Items & Unassigned Work Items**: Both sidebar trees now render the real ADO hierarchy instead of flat roots. The extension walks up the parent chain (Task → User Story → Feature → Epic) and down the children, so a Feature expands to show its User Stories, and Tasks nest under their parent Story/Task even when those parents are assigned to someone else. Hierarchy-context items are tagged "· context" (with an explanatory tooltip) so it's clear they aren't part of the base query; if the child query is rejected by your ADO org it falls back to per-parent queries, and if expansion still fails the trees fall back gracefully with a visible warning (details in Output → ADO Code)

### 0.6.0

- **Parallel tool execution**: Independent tool calls in one turn now run concurrently and results are re-ordered back to call order — several `read_file`/`search_files` calls finish as fast as one. Batches containing a consent card run sequentially so prompts never stack. Same-file edits are serialized by a per-file mutation queue so parallel batches can't race
- **Batched edits**: `edit_file` accepts an `edits[]` array — several disjoint changes to a file in a single call (each verified; applied in order)
- **`search_files` grep tool**: Now actually implemented — regex search across the workspace with `path:line` hits, 500-char per-line truncation, workspace confinement, sensible exclusions, and result caps
- **`execute_skill` fixed**: The AI can now really call `execute_skill` to load skill instructions mid-conversation (previously it errored as an unknown tool)
- **Truncated-response guard**: If a response hits the output token limit, tool calls are failed with "re-issue" instead of executing possibly-truncated arguments
- **Architecture cleanup**: Removed the legacy `BaseTool`/`ToolRegistry`/definitions layer and the abandoned BaseProvider (`-v2`) migration — tool execution now lives in one switch; −2,500+ lines

### 0.5.9

- **Reorganized Configuration UI**: Settings are now grouped into navigable sidebar categories — Connection, AI & Modes, Permissions, Workflow, and Integrations — each with a setting-count badge, so you can jump straight to what you need instead of scrolling through everything. The **Advanced** toggle now gates a dedicated Advanced category: per-mode model selection, **Model Capability Overrides** (previously settings.json-only), the **choice detection model**, and **native token counting** are all editable in the UI — toggling it on jumps straight there
- **Live thinking + tool progress**: The chat window now streams the AI's reasoning into a 💭 Thinking block and shows each tool call as a live card that appears as **running…** (spinner, arguments visible) and flips to **completed**/**error** with its result when done — clear progress instead of waiting through a silent "Thinking…" for the final answer
- **Permanent tool-call record**: Tool cards are merged into the final assistant message as collapsible blocks above the answer — expand any call to see its arguments and result, and the record survives session history
- **Hide tool calls in chat**: Configuration → Chat → *Show tool calls in chat* (default on) hides the cards; tools still run, and chat shows only a subtle pulsing "…" — no tool names, arguments, or results leave the host
- **Show AI thinking now enforced**: The *Show AI thinking* toggle (Configuration → Chat) previously had no effect — it now actually shows/hides the reasoning block in every streaming path
- **Wildcard permissions**: Configuration → Consent → *Auto-approve tools (wildcards)* accepts patterns like `read_*`, `get_*`, or exact names (`edit_file`) that skip the consent prompt in inline/act modes. Act-mode **Terminal allowlist** entries also support wildcards: `git *`, `git push *`, `npm run *` — token-by-token matching with no shell operators
- **Token consumption optimization**: tool results are capped to a token budget and older results are compacted once the model has seen them; plan mode sends only read-only tool schemas; the token budget now counts the system prompt + tools
- **Provider-native token counting**: the token status bar uses the provider's own tokenizer (Anthropic count_tokens; OpenAI-compatible via usage.prompt_tokens) with the local estimate as fallback — toggle `adoCode.llm.useNativeTokenCounting` (default on)

### 0.5.8

- **Project Creation Wizard**: Multi-step UI for creating new projects with 9 templates (Node.js TypeScript/JavaScript, Python, React, Next.js, PHP Laravel, .NET Web API/Console, Empty) — configure per-template options (ESLint, testing, Docker, etc.), optional ADO work item creation, git initialization with branch naming, review step before creation (`/new-project`)
- **Skill Management System**: Browse, install, and manage reusable AI skills — 10 built-in skills (Code Review, Documentation, Testing, Refactoring, Security Audit, Performance Profiler, Deployment Checklist, Database Schema Review, Accessibility Audit) with search, category filtering, and enable/disable toggle (`/skills`)
- **AI skill execution**: The AI can discover and use enabled skills during conversations via the `execute_skill` tool — "Execute in Chat" button injects the skill prompt and triggers the LLM
- **Skill import**: Import custom skills from local .json files, SKILL.md files (YAML frontmatter + markdown), or .tar.gz/.zip archives — imported skills persist across VS Code restarts
- **Express/Advanced Configuration**: New configuration mode toggle — Express (default) uses one model for all modes, Advanced enables per-mode model selection and reasoning effort tuning (low/medium/high) for reasoning models like o1/o3
- **Send Selection to Chat**: Right-click selected text in the editor → "ADO Code: Send Selection to Chat" inserts it as a fenced code block in the chat draft
- **Send File to Chat**: Right-click a file in the Explorer → "ADO Code: Send File to Chat" attaches it as a chip above the input bar with full content ready to send
- **Delete All Sessions**: `/clear-sessions` slash command + "🗑️ Delete All Sessions" in session history and kebab menu — wipes all sessions after in-chat confirmation
- **Confirmation cards for destructive operations**: Single session delete and delete-all show in-chat confirmation cards with danger styling instead of silently executing
- **Categorized `/help`**: Help output is grouped into Work Items, Chat, AI, and Other sections with autocomplete tip

### 0.5.7

- **Task draft editor**: AI `create_work_item` tool opens an editable markdown tab for review before creating work items in ADO
- YOLO mode: fully-autonomous mode that auto-approves every tool including shell commands — no consent prompts, no allowlist
- Consent auto-approve timer: harmless (read-only) terminal commands show a countdown timer and auto-approve on expiry (configurable, default 20s)
- Show AI thinking: models with reasoning tokens (o1/o3, Claude extended thinking) display their internal reasoning in a collapsible block
- Improved context size detection: content-aware token counting (code ~3.5, prose ~4.5 chars/token), expanded model table (27 models), better substring matching, default raised to 128k
- Dynamic context window auto-detection from `/models` API (Ollama n_ctx, OpenRouter context_length, etc.) — live data overrides hardcoded table
- Context management with priority-based truncation and auto-condensation
- Mode-aware system prompts with tool filtering
- MCP server management (disconnect/reconnect per server)
- Mode quick-cycle from Status Panel
- Worktree batch cleanup (Remove All Completed)
- Agent run history with status icons and context menus
- Agent details panel (view agent info)
- Memory search, import/export
- Work item filtering (by state, type, text)
- Agent auto-review on completion (LLM-powered code review)
- Worktree diff viewer (VS Code diff editor)
- Keyboard shortcuts for common actions
- Generate tasks from user stories (`/generate-tasks` + context menu)
- Agent progress shown in chat thread (delegation start/completion messages)
- Changelog notification on package update
- Merge-flow guardrails round 2: `commit_worktree` refuses failed runs unless `allowFailed` is set; `create_pull_request` refuses protected branches (`adoCode.git.protectedBranches`); new `resolve_pr_conflicts` tool surfaces git merge conflicts (base/our/their contents) for LLM-driven resolution
- Child task delegation: agent delegation now checks for child work items and warns the user before including them in the agent context
- Clean Up After Merge: context-menu action + auto-offer after merged PR removes the run's worktree and deletes its branch (only when the PR is actually merged and the branch is fully merged)
- Capability overrides: `adoCode.llm.capabilityOverrides` lets you declare vision/tool-calling support per model id, beating every auto-detection layer — structured editor in Configuration page
- Live model capabilities: detection is now three layers — user override > live gateway data (OpenRouter/Ollama `/models`) > name heuristic (now covers gpt-5, o1–o9, llama-4, gemma-3, deepseek-vl, glm-4.5v)
- Pre-commit hook clears git env vars so test suites don't inherit hook state

### 0.5.6

- Dedicated Worktrees view with per-worktree details and Show Agent Output
- Reopen agent output from the chat panel or Worktrees view
- Memory-driven agent hooks (`agent.before` / `agent.after`) + memory injected into agent handoffs
- Model capability checking (vision/tool-calling) with UI gating and warnings
- Model list retrieval in the Configuration page
- `.ado-code` auto-ignore for `.gitignore`/`.dockerignore`
- Branch names slugged from the ADO work item title
- Dismissed agent runs no longer reappear; summary panels dedupe on reopen
- **AI merge flow**: commit/push/PR tools for finished agent runs + worktree guardrails (concurrent-run block, stale-base warning, dirty-remove protection, merged-branch cleanup)
- Working indicator in the status bar (survives chat view being hidden)
- Background LLM processing survives panel close; pending consent cards re-post on return
- AI choice detection via optional cheap model; choice buttons now send the option as a message
- Sessions auto-create on the first message
- Full Configuration page coverage (organizations editor, choice-detection model, workspace ignore toggle) — fixes MCP-server wipe on save

### 0.5.5

- Git worktree isolation for concurrent agents
- Multi-agent output panels
- Agent summary in a formatted editor panel
- Status Panel context menus (memory, agents, worktrees)
- Work item selection highlighting + deselect
- AI choice prompt detection

### 0.5.4

- In-chat confirmation cards for all prompts
- Hierarchical work item trees
- Full detail view in the editor
- Workspace scaffolding + AGENTS.md generation + git init prompt
- Workspace-to-ADO project binding
- MCP servers configuration page

### 0.4.0

- Agent reference files (AGENTS.md, playbooks, structure scripts)
- User memory and workspace memory systems
- Slash commands with autocomplete
- Direct mode selection (click to switch)
- Pre-commit quality gates

### 0.3.0

- Checkpoint system for file save/restore
- MCP integration for external tool servers
- ADO API version update to 7.1 GA

### 0.2.0

- Core architecture: BaseTool, BaseProvider, ToolRegistry
- 5 file tools: read, search, edit, execute, list
- Modes system: code, architect, ask, debug
- Context management and UI components

### 0.1.3

- Agent delegation with Claude, Codex, OpenCode, Hermes
- Task detail review and clarification workflow

### 0.0.1

Initial release.
