# AGENTS.md — ADO Code

## What This Is
VS Code extension: AI coding assistant with Azure DevOps work item integration.
Two-layer architecture: Extension Host (Node.js/TypeScript) handles ADO REST API,
LLM API, editor interactions. Webview Panel (React/TypeScript) renders chat UI.
Communication via VS Code postMessage bridge.

## Build & Test
- `npm run compile` — TypeScript compilation (must be clean before any commit)
- `npm test` — Mocha test suite (83+ tests, runs in VS Code electron)
- `npm run build:webview` — Webpack bundle for React webview
- `npm run build:all` — compile + webview
- `npm run lint` — ESLint
- `npx vsce package --allow-missing-repository` — build VSIX

## Project Structure
src/ extension entry point and services composition root
src/ado/ ADO REST API client, tree view, types
src/agents/ Agent registry, runner, adapters (Claude, Codex, OpenCode, Hermes, Pi, Gemini, Generic)
src/changelog/ CHANGELOG.md auto-update
src/config/ VS Code settings, ContextProxy
git/GitService.ts Git operations
src/llm/ LLM client, agentic loop, tools, providers, modes, prompts, context, consent
src/llm/tools/ BaseTool, ToolRegistry, 5 tool implementations + definitions
src/llm/providers/ BaseProvider, openai-v2, anthropic-v2
src/llm/context/ tokenCounter, contextManager, condenser
src/memory/ UserMemory, WorkspaceMemory
src/services/ checkpoints/, mcp/
src/shared/ Message protocol types
src/webview/ ChatViewProvider
src/webview-ui/ React app (components/, styles/)

## Architecture

### Extension Host
Entry: src/extension.ts activate()
Composition: src/services.ts createServices() builds: ado, git, changelog, agents, checkpoints, mcp, memory, workspaceMemory

### LLM Layer
client.ts — streaming chat, tool-calling
agentic.ts — multi-iteration tool loop
tools.ts — mode-gated dispatch (inline/plan/act)
tools/ — BaseTool, ToolRegistry, definitions
providers/ — BaseProvider, openai-v2, anthropic-v2
modes.ts — code/architect/ask/debug
prompts/system.ts — dynamic system prompt
context/ — token counting, windowing, condensation

### ADO Integration
client.ts — REST API (all api-version=7.1)
WorkItemsTreeProvider.ts — tree view
WorkItemStatesCache.ts — cached states

### Agent System
registry.ts — detects installed CLIs
AgentRunner.ts — background execution
adapters/ — 7 adapter implementations

### Memory System
UserMemory.ts — per-user preferences (VS Code globalState)
WorkspaceMemory.ts — per-project conventions (.ado-code/memory/)

### Webview
ChatViewProvider.ts — message routing, commands
webview-ui/src/ — React app with components
shared/messages.ts — typed message protocol

## Key Patterns

### Tool System
Tools defined as OpenAI-compatible JSON Schema.
BaseTool abstract class provides lifecycle.
ToolRegistry manages instances, dispatches by name.
ToolExecutor gates by mode: plan=read-only, inline=consent, act=auto-approve.
Tool names: get_work_items, get_work_item, read_file, edit_file, write_to_file,
search_files, list_files, apply_diff, run_terminal_command, delegate_to_agent,
restore_checkpoint, set_memory, read/write/list_workspace_memory, mcp__<server>__<tool>

### Message Protocol
src/shared/messages.ts defines typed contract.
WebviewToExtensionMessage: ~30 types.
ExtensionToWebviewMessage: ~20 types.

### Service Composition
createServices() is composition root.
AdoClient uses lazy Proxy (reconstructed on org switch).

### Testing
Mocha with suite()/test() (TDD UI).
Test files: src/test/suite/<category>/<name>.test.ts
Runner: @vscode/test-electron

## Conventions
- TypeScript strict mode, ES modules → CommonJS
- Zero runtime dependencies (devDependencies only)
- No external UI libraries (VS Code CSS variables)
- Workspace-relative paths (path confinement enforced)
- ADO API: api-version=7.1 (GA) or 7.1-preview.4 (comments)
- Tool errors return JSON { error: string }, never throw

## What NOT to Do
- Do not add runtime dependencies without approval
- Do not use any types where avoidable
- Do not skip approval hook for mutating tools in inline mode
- Do not use preview API versions where GA exists
- Do not commit without npm run compile && npm test passing
