# ADO Code

AI coding assistant with Azure DevOps work item integration for VS Code.

## Features

- Fetch work items assigned to you from Azure DevOps (My Work Items + Unassigned trees, hierarchical Epic → Feature → User Story → Task)
- AI chat assistant with OpenAI-compatible and Anthropic-compatible LLM support
- Tool calling with agentic loop for autonomous coding tasks (Chat/Plan/Act modes)
- Git-based task workflow: auto-create branch on pickup, update CHANGELOG.md on completion
- External agent orchestration (Claude Code, Codex, OpenCode, Hermes, Pi, and more)
- **Git worktree isolation**: Concurrent agents run in isolated worktrees — no branch conflicts
- **Worktrees view**: Dedicated sidebar tree with per-worktree details — run status, agent, dirty/clean files, last commit, ahead/behind — plus Open in Terminal/Explorer, Remove, and Show Agent Output actions
- **Reopen agent output**: Finished runs keep a "↗ Reopen" button and right-click → **Show Agent Output** — the summary panel is never permanently lost after being closed
- **Memory-driven agent hooks**: Workspace memory keys `agent.before` / `agent.after` run shell commands around every agent invocation; user + workspace memory are injected into every agent handoff prompt
- **Model capability checking**: Image paste/attach is disabled for non-vision models, models without tool calling are flagged, and the Configuration page shows a live capability readout
- Multi-agent output panels: track multiple agent runs simultaneously with independent streaming output
- File checkpoints: auto-save before AI edits, restore on demand
- MCP (Model Context Protocol) support for external tool servers
- Slash commands with autocomplete (/help, /status, /clear, /mode, /delegate, …)
- User memory: AI remembers your preferences across sessions
- Workspace memory: project-specific conventions in `.ado-code/memory/` — kept out of git/Docker via auto-ignore
- **`.ado-code` auto-ignore**: The workspace data directory is offered to be added to `.gitignore`/`.dockerignore` on load (setting `adoCode.ignore.dotAdoCode`, default on)
- Direct mode selection: click Chat/Plan/Act to switch modes instantly
- In-chat confirmation cards: task start, mode switch, and other prompts render as styled cards inside the chat
- **AI choice detection**: When the AI asks you to choose, options appear as clickable buttons — clicking one sends the option as a follow-up message; natural-language offers ("Want me to …?") are parsed via an optional cheap model (`adoCode.llm.choiceDetectionModel`), and long options stack as full-width rows
- **AI merge flow**: For finished agent runs, the assistant can commit, push, and open an ADO pull request itself (`commit_worktree` → `push_worktree` → `create_pull_request`) — never force-pushes, never touches `main`/`master`
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

Configure in VS Code settings under `adoCode.*`:

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
| `adoCode.llmModel` | LLM model name |
| `adoCode.llm.choiceDetectionModel` | Optional cheaper model for AI choice-prompt detection (empty = main model, `off` = regex-only) |
| `adoCode.mode` | Tool-use mode: `inline`, `plan`, or `act` |
| `adoCode.act.toolBudget` | Max tool calls per act-mode turn |
| `adoCode.act.terminalAllowlist` | Allowed command prefixes in act mode |
| `adoCode.git.requireGitRepo` | Block task pickup outside a git repo |
| `adoCode.git.createBranchOnTaskStart` | Auto-create `feature/ADO-<id>-<slug>` branch |
| `adoCode.git.requireCleanTree` | Warn on branch switch with uncommitted changes |
| `adoCode.git.prOnCompletion` | Offer to push + create a PR via `gh` on task done |
| `adoCode.changelog.enabled` | Update CHANGELOG.md on task completion |
| `adoCode.changelog.autoCommit` | Commit CHANGELOG.md automatically |
| `adoCode.changelog.postToAdo` | Post the changelog entry as an ADO comment |
| `adoCode.ignore.dotAdoCode` | Offer to add `.ado-code` to `.gitignore`/`.dockerignore` (default `true`) |
| `adoCode.sessions.maxPerProject` | Max chat sessions kept per workspace + project |
| `adoCode.agents.enabled` | Which external agents may be delegated to |
| `adoCode.agents.verifyCommand` | Shell command run after an agent finishes |
| `adoCode.agents.autoSelect` | Default agent when none is specified |
| `adoCode.mcp.servers` | MCP server configurations (array of `{ name, command, args?, env?, timeout? }`) |

## Slash Commands

Type `/` in the chat input to see available commands:

| Command | Description |
|---------|-------------|
| `/status <state>` | Change work item state |
| `/comment <text>` | Add a comment to the active work item |
| `/pick` | Select a work item from the list |
| `/assign <who>` | Reassign the active work item |
| `/clear` | Clear chat history |
| `/mode <mode>` | Switch mode (inline, plan, act) |
| `/undo` | Restore files to the last checkpoint |
| `/help` | Show available commands |
| `/delegate [agent]` | Delegate to an external agent |
| `/resume` | Resume an interrupted agent session |
| `/remember <what>` | Remember a preference or instruction |
| `/forget <key>` | Remove a memory entry |

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
