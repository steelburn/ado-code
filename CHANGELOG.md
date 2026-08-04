# Changelog

All notable changes to ADO Code will be documented in this file.

## [0.3.0] - 2026-08-04

### Checkpoint System
- File-level checkpoint service for saving/restoring workspace files before AI edits
- Auto-save checkpoint before mutating tool calls (edit_file, write_to_file, apply_diff)
- `restore_checkpoint` tool for the LLM to undo file changes
- Configurable max checkpoints per task (default 50, FIFO eviction)

### MCP Integration
- MCP (Model Context Protocol) client for connecting to external tool servers
- Support for stdio-based MCP servers via JSON-RPC 2.0
- `McpManager` for managing multiple MCP server connections
- Tools exposed as `mcp__<server>__<tool>` in the agentic loop
- Configuration via `adoCode.mcp.servers` setting

### ADO API Version Update
- Updated all Azure DevOps REST API calls to version 7.1 (GA)
- Comments API updated from 6.0 to 7.1-preview.4 (latest available)
- Removed all preview API version suffixes where GA versions exist

## [0.2.0] - 2026-08-04

### Phase 1: Core Architecture
- BaseTool abstract class with typed parameters, execution lifecycle, and error handling
- BaseProvider interface for LLM provider abstraction
- ToolRegistry for dynamic tool registration and discovery
- ContextProxy for workspace-safe context passing

### Phase 2: Tool Implementations
- ReadTool: file reading with line ranges and offset support
- SearchTool: content and filename search across workspace
- EditTool: targeted find-and-replace edits with fuzzy matching
- ExecuteTool: terminal command execution with timeout and working directory
- ListTool: directory listing with glob filtering

### Phase 2: Provider Abstraction
- OpenAI v2 provider with streaming support
- Anthropic v2 provider with streaming support

### Phase 2: Modes System
- Code mode: streaming with inline tool calls
- Architect mode: read-only tools, produces implementation plans
- Ask mode: conversational, no tools
- Debug mode: diagnostic-focused with verbose output

### Phase 2: Context Management
- Token counter for accurate context size estimation
- Context manager with automatic windowing
- Context condenser for long conversations

### Phase 2: UI Components
- Button, Tooltip, Dialog, Toggle, Badge, Card component library
- Enhanced MessageList with markdown rendering and tool call cards
- Enhanced InputBar with @file mention, image paste, and message history

### Phase 2: @File Mention with Real Workspace Search
- Type `@` in the input bar to search workspace files
- Real-time file suggestions from the extension host via VS Code `findFiles` API
- Keyboard navigation (arrow keys, Enter/Tab to select, Escape to dismiss)

### Security
- Workspace boundary validation on all file tools (read, search, edit, list)
- Platform-safe process kill for WSL/Windows environments

## [0.1.3] - 2026-07-15

### Added
- Agent delegation with Claude, Codex, OpenCode, Hermes, and other agents
- Task detail review and clarification workflow
- Consent card for inline-mode mutating tools
- Project switcher in chat header
- CHANGELOG auto-update on task completion
