# ADO Code

AI coding assistant with Azure DevOps work item integration for VS Code.

## Features

- Fetch work items assigned to you from Azure DevOps
- AI chat assistant with OpenAI-compatible and Anthropic-compatible LLM support
- Tool calling with agentic loop for autonomous coding tasks
- Git-based task workflow: auto-create branch on pickup, update CHANGELOG.md on completion
- External agent orchestration (Claude Code, Codex, OpenCode, Hermes, and more)
- File checkpoints: auto-save before AI edits, restore on demand
- MCP (Model Context Protocol) support for external tool servers
- Slash commands with autocomplete (/help, /status, /clear, /mode, etc.)
- User memory: AI remembers your preferences across sessions
- Workspace memory: project-specific conventions in .ado-code/memory/
- Direct mode selection: click Chat/Plan/Act to switch modes instantly
- In-chat confirmation cards: task start, mode switch, and other prompts render as styled cards inside the chat
- Hierarchical work item trees: parent-child view matching ADO structure (Epic → Feature → User Story → Task) with type-specific icons
- Full detail view: right-click → "Show Full Details" opens a formatted panel in the editor with metadata, description, criteria, and discussion
- Agent delegation injects AGENTS.md project context so all agents understand the codebase
- Workspace scaffolding: new project wizard for Node.js, Python, PHP (Laravel), .NET C# with auto-generated files
- Workspace-to-ADO project binding: prevents working on items from the wrong project
- Enhanced slash command autocomplete with parameter hints and real-world examples

## Requirements

- VS Code 1.85.0+
- Node.js 18+
- A git-enabled workspace folder
- Azure DevOps PAT (Personal Access Token) with `vso.work_write` scope

## Extension Settings

Configure in VS Code settings under `adoCode.*`:

| Setting | Description |
|---------|-------------|
| `adoCode.adoOrganization` | Azure DevOps organization name |
| `adoCode.adoProject` | Azure DevOps project name |
| `adoCode.adoPat` | Personal Access Token |
| `adoCode.llmProvider` | `openai` (default) or `anthropic` |
| `adoCode.llmApiUrl` | LLM API endpoint |
| `adoCode.llmApiKey` | LLM API key |
| `adoCode.llmModel` | LLM model name |
| `adoCode.mode` | Tool-use mode: `inline`, `plan`, or `act` |
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

Commit `.ado-code/memory/` to share with your team.

## Release Notes

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
