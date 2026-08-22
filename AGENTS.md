# AGENTS.md — ADO Code

## What This Is
VS Code extension: AI coding assistant with Azure DevOps work item integration.
Two-layer architecture: Extension Host (Node.js/TypeScript) handles ADO REST API,
LLM API, editor interactions. Webview Panel (React/TypeScript) renders chat UI.
Communication via VS Code postMessage bridge.

## Build & Test
- `npm run compile` — TypeScript compilation (must be clean before any commit)
- `npm test` — Mocha test suite (249+ tests, runs in VS Code electron)
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
src/git/GitService.ts Git operations, gitError.ts error messages, mergeCleanup.ts post-merge cleanup, mergeConflicts.ts conflict surfacing
src/llm/ LLM client, agentic loop, tools, providers, modes, prompts, context, consent
src/llm/tools/ types.ts only (tool names/params/groups); ALL tool implementations live in src/llm/tools.ts createToolExecutor()
src/llm/providers/ BaseProvider, openai, anthropic (the -v2/BaseProvider migration and handler.ts were removed — client.ts + LlmProvider interface is the live path)
src/llm/context/ tokenCounter, contextManager, condenser
src/memory/ UserMemory, WorkspaceMemory
src/services/ checkpoints/, mcp/, ignoreFiles/ (keeps `.ado-code` out of .gitignore/.dockerignore)
src/shared/ Message protocol types
src/webview/ ChatViewProvider, StatusPanelProvider, WorktreesTreeProvider (dedicated agent-worktree view)
src/webview-ui/ React app (components/, styles/)

## Architecture

### Extension Host
Entry: src/extension.ts activate()
Composition: src/services.ts createServices() builds: ado, git, changelog, agents, checkpoints, mcp, memory, workspaceMemory

### LLM Layer
client.ts — streaming chat, tool-calling
agentic.ts — multi-iteration tool loop (parallel batch execution + consent-aware batching)
tools.ts — mode-gated dispatch (inline/plan/act/yolo); single home for all tool implementations
tools/ — types.ts only (tool names/params/groups)
providers/ — BaseProvider, openai, anthropic
modes.ts — inline/plan/act/yolo mode configs
prompts/system.ts — dynamic system prompt
context/ — token counting, windowing, condensation
modelCapabilities.ts — three-layer capability inference (override > live gateway > name heuristic)

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
Memory is injected into the chat system prompt AND into every external-agent
handoff prompt (framed as "ADO Code Memory (instructions you MUST honor)";
the hook keys below are excluded from the agent context). Workspace memory
keys `agent.before` / `agent.after` run as shell hooks around each agent
invocation: `agent.before` executes in the run's workdir before the adapter
starts (output streams to the run panel), `agent.after` runs on completion
and its output is captured into the summary (AgentRunner.runPreHook +
verifyWork).

### Webview
ChatViewProvider.ts — message routing, commands
webview-ui/src/ — React app with components
shared/messages.ts — typed message protocol

## Key Patterns

### Tool System
Tools defined as OpenAI-compatible JSON Schema and implemented in the single
createToolExecutor() switch (src/llm/tools.ts). The legacy BaseTool/ToolRegistry/
definitions/ path was removed.
ToolExecutor gates by mode: plan=read-only, inline=consent, act=auto-approve,
yolo=auto-approve everything (no consent, no allowlist). gateTool() is the shared
gate used by execute() and canAutoExecute(); the agentic loop runs batches in
PARALLEL unless a call would prompt (then sequential, one consent card at a time),
with a per-file mutation queue for same-file edits and a truncated-response guard
(stopReason length/max_tokens ⇒ fail the batch, never execute partial args).
Tool names: get_work_items, get_work_item, read_file, edit_file, write_to_file,
search_files (grep with per-line 500-char truncation), apply_diff,
run_terminal_command, delegate_to_agent, restore_checkpoint, set_memory,
execute_skill (loads skill instructions, read-only), read/write/list_workspace_memory,
commit_worktree, push_worktree, create_pull_request, resolve_pr_conflicts,
mcp__<server>__<tool>

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
