# Changelog

All notable changes to ADO Code will be documented in this file.

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
