# Roo-Code Adaptation Phase 2: Advanced Features

## Overview
Build on the Phase 1 foundation (BaseTool, BaseProvider, ToolRegistry, etc.) to add
advanced features from Roo-Code: UI components, Modes, Context management, MCP,
Checkpoints, and Code indexing.

## Dependencies
- Phase 1 complete (all 16 tasks done)
- Existing: BaseTool, BaseProvider, ToolRegistry, Tool definitions, ContextProxy

---

## Phase 5: UI Component Library

### Task 5.1: Create shared UI primitives
- **Source:** `Roo-Code/webview-ui/src/components/ui/` (button, tooltip, dialog, toggle-switch)
- **Target:** `src/webview-ui/src/components/ui/` (new directory)
- **What:** Reusable UI components styled with VS Code CSS variables
- **Components to create:**
  - Button.tsx — styled button with variants (primary, secondary, ghost)
  - Tooltip.tsx — VS Code tooltip wrapper
  - Dialog.tsx — modal dialog with overlay
  - ToggleSwitch.tsx — on/off toggle
  - Badge.tsx — status badges
  - Card.tsx — content container
- **Pattern:** Simple React components, no external UI library (keep bundle small)
- **Styling:** Use VS Code CSS variables (--vscode-*) for theme compliance
- **Tier:** Standard

### Task 5.2: Create MessageList component
- **Source:** `Roo-Code/webview-ui/src/components/chat/ChatRow.tsx` (adapt)
- **Target:** `src/webview-ui/src/components/MessageList.tsx` (refactor existing)
- **What:** Enhanced message rendering with tool use blocks, code highlighting
- **Features:**
  - Render assistant messages with markdown
  - Show tool use/result blocks with expand/collapse
  - Code syntax highlighting
  - Timestamps and message grouping
- **Tier:** Standard

### Task 5.3: Create InputBar enhancements
- **Source:** `Roo-Code/webview-ui/src/components/chat/ChatTextArea.tsx` (adapt)
- **Target:** `src/webview-ui/src/components/InputBar.tsx` (refactor existing)
- **What:** Enhanced input with file mentions, image attachments
- **Features:**
  - @file mention system (type @ to search files)
  - Image paste/drag-drop support
  - Keyboard shortcuts (Enter to send, Shift+Enter for newline)
  - Send button with loading state
- **Tier:** Standard

---

## Phase 6: Modes System

### Task 6.1: Create ModeConfig types and registry
- **Source:** `Roo-Code/src/shared/modes.ts` (adapt)
- **Target:** `src/llm/modes.ts` (new file)
- **What:** Mode configuration system with tool filtering
- **Features:**
  - ModeConfig interface (slug, name, role, toolGroups, customInstructions)
  - Default modes: code, architect, ask, debug
  - Tool group filtering (read, write, execute, mcp)
  - Custom mode support
  - Mode persistence via ContextProxy
- **Tier:** Critical (affects tool dispatch)

### Task 6.2: Create system prompt generator
- **Source:** `Roo-Code/src/core/prompts/system.ts` + `sections/` (adapt)
- **Target:** `src/llm/prompts/system.ts` (new file)
- **What:** Dynamic system prompt generation based on mode
- **Features:**
  - Mode-specific role definitions
  - Tool usage guidelines per mode
  - Custom instructions injection
  - Environment context (OS, workspace, git status)
- **Tier:** Critical (affects LLM behavior)

### Task 6.3: Wire modes into ToolRegistry
- **Source:** Adapt existing ToolRegistry
- **Target:** `src/llm/tools/ToolRegistry.ts` (modify)
- **What:** Add mode-aware tool filtering
- **Changes:**
  - getToolsForMode(mode) — filter tools by mode's toolGroups
  - getToolDefinitionsForMode(mode) — filtered definitions for API
  - Mode switching support
- **Tier:** Critical (integration)

---

## Phase 7: Context Management

### Task 7.1: Create token counter
- **Source:** `Roo-Code/src/utils/countTokens.ts` + `src/workers/countTokens.ts`
- **Target:** `src/llm/context/tokenCounter.ts` (new file)
- **What:** Token counting for context window management
- **Features:**
  - Count tokens in messages
  - Estimate remaining context window
  - Use tiktoken for accurate counting
- **Tier:** Standard

### Task 7.2: Create context manager
- **Source:** `Roo-Code/src/core/context-management/` (adapt)
- **Target:** `src/llm/context/contextManager.ts` (new file)
- **What:** Manage context window to prevent overflow
- **Features:**
  - Track total tokens used
  - Truncate old messages when approaching limit
  - Summarize truncated content
  - Priority-based message retention
- **Tier:** Standard

### Task 7.3: Create conversation condenser
- **Source:** `Roo-Code/src/core/condense/` (adapt)
- **Target:** `src/llm/context/condenser.ts` (new file)
- **What:** Summarize long conversations to save context
- **Features:**
  - Detect when context is getting full
  - Use LLM to summarize older messages
  - Preserve key information (file changes, decisions)
  - Replace summarized messages with summary
- **Tier:** Standard (optional, high value)

---

## Phase 8: MCP Integration (Optional)

### Task 8.1: Create MCP client wrapper
- **Source:** `Roo-Code/src/services/mcp/McpHub.ts` (first 500 lines)
- **Target:** `src/services/mcp/McpClient.ts` (new file)
- **What:** Simplified MCP client for external tool servers
- **Features:**
  - Connect to MCP servers (stdio, SSE)
  - List available tools
  - Call tools and return results
  - Handle server lifecycle
- **Note:** This is complex (~2000 lines in Roo-Code). Simplify heavily.
- **Tier:** Low priority (nice-to-have)

---

## Phase 9: Checkpoint System (Optional)

### Task 9.1: Create checkpoint service
- **Source:** `Roo-Code/src/services/checkpoints/` (adapt)
- **Target:** `src/services/checkpoints/checkpointService.ts` (new file)
- **What:** Save/restore file state before AI edits
- **Features:**
  - Save file contents before modification
  - Restore files to pre-edit state
  - List checkpoints for a task
  - Diff between checkpoint and current
- **Tier:** Low priority (nice-to-have, safety feature)

---

## Implementation Order

### Batch 1 (Foundation): Tasks 6.1, 7.1
These are type/utility foundations with no dependencies.

### Batch 2 (Core): Tasks 5.1, 6.2, 7.2
Build on batch 1 foundations.

### Batch 3 (Integration): Tasks 5.2, 5.3, 6.3, 7.3
Wire everything together.

### Batch 4 (Optional): Tasks 8.1, 9.1
Only if time permits.

---

## Verification Commands
```bash
npm run compile        # TypeScript compilation
npm run lint           # ESLint
npm test               # Mocha tests
npm run build:webview  # Webview build
```
