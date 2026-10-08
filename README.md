# ADO Code

AI coding assistant with Azure DevOps work item integration for VS Code.

## Features

- Fetch work items from Azure DevOps in one tree view with a mode toggle — My Work Items / All Work Items / Unassigned — rendered as a real hierarchy (Epic → Feature → User Story → Task)
- AI chat assistant with OpenAI-compatible and Anthropic-compatible LLM support
- Tool calling with agentic loop for autonomous coding tasks (Chat/Plan/Act/YOLO modes) — independent tool calls run in parallel (even in mixed batches: consent-free calls don't wait behind approval cards), batched `edit_file` edits, batch `get_work_item` `ids` / `run_terminal_command` `commands` arrays, and a `search_files` grep tool with per-line truncation
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
- **Visible agentic turn records**: Reasoning streams as “Thinking” blocks that stay between the tool batches they introduced, and a finished turn keeps its whole ordered record in the thread — every thinking block and tool card visible (collapsible), followed by the answer
- **Two-sided chat layout**: AI responses on the left; your messages on the right as compact bubbles
- **Iteration budget = model round-trips, and maxed-out turns conclude**: `adoCode.act.toolBudget` counts model round-trips (a thinking step that fires several parallel tools is one iteration, not one per tool), and a turn that exhausts the budget ends with the AI explaining in the chat that it hit the limit and summarizing progress — never a bare error
- **AI choice detection**: When the AI asks you to choose, options appear as clickable buttons — clicking one sends the option as a follow-up message; natural-language offers ("Want me to …?") are parsed via an optional cheap model (`adoCode.llm.choiceDetectionModel`), and long options stack as full-width rows
- **Reorganized Configuration UI**: Settings are grouped into navigable sidebar categories — Connection, AI & Modes, Permissions, Workflow, and Integrations — each with a setting-count badge, so you can jump straight to what you need instead of scrolling. The Advanced toggle gates a dedicated **Advanced** category: per-mode model selection, capability overrides, the choice detection model, and native token counting
- **Project Creation Wizard**: Multi-step UI for creating new projects with 9 templates (Node.js, Python, React, Next.js, Laravel, .NET) — configure options, ADO integration, and git setup before creation (`/new-project`)
- **Wizard focus**: The Configuration page, project-creation wizard, and first-run setup take over the whole sidebar while open — the sibling views (Work Items / Status / Worktrees) collapse automatically and are restored when the wizard closes, so wizards never share space with the trees. The chat kebab's "Configuration…" opens the in-app Configuration page
- **Skill Management System**: Browse, install, and manage reusable AI skills — 10 built-in skills (Code Review, Documentation, Testing, Refactoring, Security Audit, Performance Profiler, Deployment Checklist, Database Schema Review, Accessibility Audit) with search, filtering, and enable/disable toggle (`/skills`)
- **AI skill execution**: The AI can discover and use enabled skills during conversations via the `execute_skill` tool — "Execute in Chat" button injects the skill prompt and triggers the LLM
- **Skill import**: Import custom skills from local .json files, SKILL.md files (YAML frontmatter + markdown), or .tar.gz/.zip archives — imported skills persist across VS Code restarts
- **External skill registries**: Browse and install community skills from remote TSV registries (`slug<TAB>url<TAB>description`) — the built-in UI Skills registry is always included, and you can add more via `adoCode.skillRegistryUrls`. Registry skills carry a "registry" badge in the Skill Catalog and are downloaded + imported (SKILL.md) when you install them
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
- **Parent delegation completes child items**: Delegating a parent work item (Story/Feature/Epic) covers its entire descendant subtree — the agent gets a numbered **delivery checklist** of every open child and must end with a `## Delivery Report` marking each `DONE` / `BLOCKED` / `INCOMPLETE`. With `adoCode.agents.autoCompleteChildren` enabled, the extension then comments + transitions each done child to its terminal state and closes the parent once all children are done (partial success leaves it open with a comment). Without the setting, the run reports and comments only. You're warned before delegating and can skip the children; a parent/child concurrency guard prevents overlapping runs
- **Agent progress in chat**: Agent delegation shows start/completion messages in the chat thread alongside the streaming output panel — with a live elapsed-time readout while a run is in flight
- **Live agent progress in the editor**: Move any agent run's progress to the editor area — real-time streaming output with timestamps and event styling, live elapsed clock, progress bar, and the final summary in the same panel. Auto-open per run via `adoCode.agents.progressView = editor`, or on demand via the ↗ button on the chat output panel (running or finished) or the **ADO Code: Open Agent Progress…** command
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
- **Standalone / unattached project mode**: Choose `None (no project)` in the header project dropdown to work independently with the AI assistant without attaching to an Azure DevOps project, or when ADO connectivity is not configured
- **Interactive Mermaid diagram rendering & SVG export**: Mermaid diagrams (flowcharts, sequence diagrams, class diagrams, state diagrams, ER diagrams, Gantt charts, etc.) render interactively across Chat, Task Details, Work Item Details, and Agent Run Summaries — with instant `[ 📊 Diagram | </> Code ]` view switching, `📋 Copy Code`, `🖼️ Copy SVG`, and `💾 Save SVG` (native file save dialog with auto-named `.svg` file export)
- **Move chat into editor area**: Open the chat assistant in the main editor area as a tab (`$(link-external)`) or move it back to the sidebar (`$(layout-sidebar-left)`) seamlessly without losing conversation state, session history, or task bindings. The editor tab is reopened automatically if it was open when the IDE was closed
- **Chat-area declutter**: a turn's consecutive tool calls fold into one `Ran N tools ▸` activity row (expandable to the unchanged per-tool cards), boxed "Thinking" blocks become quiet dimmed text, and a one-line turn summary (`8 tools · 1 edit · 42s · 3.1k tokens`) sits above each finished answer — with a "Show details" toggle to reveal everything on demand
- **Chat density modes** (`adoCode.chat.density`): dial the chat from fully narrated (`comfortable`, default) through `compact` down to `answers-only` (folds activity rows, reasoning, and attachments behind "Show details") — cycle from the kebab menu (`Chat density: …`) or set it in the Configuration page
- **Queue vs. steer for mid-run input** (`adoCode.chat.inputWhileBusy`, default `steer`): type while the AI is working and either **steer** — your text is injected into the running turn's next iteration so the agent folds it into the work in progress — or **queue** it as a numbered pending chip (per-item remove button) that is sent when the turn finishes
- **Delegation suggestions** (`adoCode.chat.suggestDelegation`, default on): the assistant can offer to hand a large, self-contained task to an installed external agent, surfaced as a single compact action card in the chat
- **View archived goals in the To-do view**: a toolbar toggle (`$(archive)` / `$(checklist)`) switches the session's To-do list between the live list and a read-only history of superseded completed goals

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
| `adoCode.organizations` | ADO organizations (array of `{ name, url, project, pat? }`) — optional per‑org PAT that overrides the global `adoCode.adoPat` |
| `adoCode.adoOrganization` | Active Azure DevOps organization name |
| `adoCode.adoProject` | Active Azure DevOps project name (empty for standalone / no project) |
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
| `adoCode.act.toolBudget` | Max agentic loop iterations per chat turn (default `100`, recommended `100+` for large repositories; each iteration = one model round-trip that may run several tool calls in parallel) |
| `adoCode.act.terminalAllowlist` | Allowed command prefixes in act mode |
| `adoCode.consent.harmlessAutoApprove` | Auto-approve harmless (read-only) terminal commands immediately — no consent card, no countdown (default `false`) |
| `adoCode.consent.autoApproveTools` | Tool names or glob patterns (`read_*`, `get_*`, `edit_file`) that skip the consent prompt in inline/act modes (default `[]`) |
| `adoCode.yolo.pushApproval` | Require approval before pushing to the remote repo (`push_worktree` / `git push`) even in YOLO mode (default `true`) |
| `adoCode.chat.showThinking` | Show the model's thinking/reasoning text while it processes (default `true`) |
| `adoCode.chat.showToolCalls` | Show live tool-call cards in the chat while the AI works (default `true`; off shows only a pulsing "…" indicator) |
| `adoCode.chat.density` | Chat rendering density: `comfortable` (default — everything shown), `compact` (tighter spacing), or `answers-only` (folds activity rows, reasoning, attachments, and chrome behind "Show details") |
| `adoCode.chat.inputWhileBusy` | What happens when you type while the AI is working: `steer` (default — inject into the running turn's next iteration) or `queue` (hold as a numbered pending chip, sent when the turn finishes) |
| `adoCode.chat.suggestDelegation` | Let the assistant suggest delegating suitable (large, self-contained) work to an installed external agent via a compact action card (default `true`) |
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
| `adoCode.agents.autoCompleteChildren` | After a delegated parent run succeeds, auto-complete its children in ADO: children marked DONE in the agent's Delivery Report transition to their terminal state (Task/Bug → Closed, Story/Feature/Epic → Resolved), and the parent closes when all open children are done (default `false`; off = report + comment only) |
| `adoCode.mcp.servers` | MCP server configurations (array of `{ name, command, args?, env?, timeout? }`) |
| `adoCode.skillRegistryUrls` | Extra skill registry URLs to browse in the Skill Catalog (TSV format: `slug<TAB>url<TAB>description`); the built-in UI Skills registry is always included |

## To-do View

The **To-do** view (`adoCode.todos`) in the ADO Code activity bar is the AI's task list for the **active chat session**, rendered as a checkbox tree. It is **session-scoped**: the active session's goal is the single root node with its steps nested below, so switching chat sessions switches the list. Each session's list is persisted under `.ado-code/todos/`.

- **Goal at the top**: the session objective is shown as the root node (a `$(target)` icon if set, otherwise a `$(checklist)` placeholder). Set, edit, or clear it with the `/goal` slash command, the **Set Session Goal** toolbar button, or the goal node's context menu.
- **Steps below**: the assistant adds steps as it plans; add your own with the **Add To-do Item** toolbar button or an item's context menu. Each step carries a status icon — `$(sync~spin)` in progress, `$(pass-filled)` completed, `$(circle-large-outline)` pending — and its checkbox toggles between **Mark as Completed** and **Mark as Pending**. Remove a step with **Remove To-do Item**.
- **Archive**: the `$(archive)` / `$(checklist)` toolbar toggle switches between the live list and a read-only **history of superseded, completed goals** for the session — useful for reviewing what earlier goals in the same chat accomplished.
- **Badge**: the view badge shows the number of remaining (not-yet-completed) steps in the active session.
- **Toolbar**: **Add To-do Item**, **Refresh To-do List**, **Set/Clear Session Goal**, **Clear To-do List**, and the archive toggle. Item and goal context menus expose the per-node actions above.

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
| `/delegate [agent] <prompt>` | Hand off the active task to an external agent (claude, codex, opencode, hermes, pi, gemini, dsh) |
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
- **Parent runs**: delegating a parent work item runs the whole subtree in ONE worktree/branch/PR — children are a delivery checklist inside the prompt, and the post-run sync (see the settings table) updates ADO states when it finishes
- **Guardrails**: two agents can never run on the same work item concurrently — including overlapping parent/child runs (a parent run covers its descendants); reusing a stale branch warns; **Remove** refuses silently discarding dirty work (offers *Commit & Push, then Remove*) and deletes the local branch afterwards only when it is fully merged — commits are never lost

## Model Capabilities

The extension infers the active model's capabilities from its id:

- **Vision**: models without image support get the chat's image paste/attach disabled
- **Tool calling**: models without it show a persistent warning that agentic modes degrade to plain chat
- The Configuration page shows a live readout ("Capabilities: vision · tool calling") for the selected model and highlights models lacking tool calling


## Release Notes

See [CHANGELOG.md](CHANGELOG.md) for the full version history.

## License

ADO Code is released under the [MIT License](LICENSE).
