# ADO Code

AI coding assistant with Azure DevOps work item integration for VS Code.

## Features

- Fetch work items assigned to you from Azure DevOps
- AI chat assistant with OpenAI-compatible and Anthropic-compatible LLM support
- Tool calling with agentic loop for autonomous coding tasks
- Git-based task workflow: auto-create branch on pickup, update CHANGELOG.md on completion
- Post completion status back to the ADO work item discussion thread
- External agent orchestration (Claude Code, Codex, OpenCode, Hermes, and more)
- File checkpoints: auto-save before AI edits, restore on demand
- MCP (Model Context Protocol) support for external tool servers

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
| `adoCode.mcp.servers` | MCP server configurations (array) |

## Release Notes

### 0.3.0

- Checkpoint system: auto-save before file edits, restore on demand
- MCP integration: connect to external tool servers
- ADO API version update to 7.1 GA

### 0.2.0

- Core architecture: BaseTool, BaseProvider, ToolRegistry
- 5 file tools: read, search, edit, execute, list
- Modes system: code, architect, ask, debug
- Context management: token counting, windowing, condensation
- UI component library and enhanced chat interface

### 0.1.3

- Agent delegation with Claude, Codex, OpenCode, Hermes
- Task detail review and clarification workflow

### 0.0.1

Initial release.
