# ADO Code

AI coding assistant with Azure DevOps work item integration for VS Code.

## Features

- Fetch work items assigned to you from Azure DevOps
- AI chat assistant with OpenAI-compatible and Anthropic-compatible LLM support
- Git-based task workflow: auto-create branch on pickup, update CHANGELOG.md on completion
- Post completion status back to the ADO work item discussion thread
- External agent orchestration (Claude Code, Codex, OpenCode, Hermes, and more)

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

## Release Notes

### 0.0.1

Initial release.
