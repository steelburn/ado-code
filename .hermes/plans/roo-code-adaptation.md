# Roo-Code → ADO-Code Adaptation Plan

## Overview
Adapt proven patterns from Roo-Code (Apache 2.0) into our ADO Code VS Code extension
to upgrade it from a basic coding assistant to a professional-grade tool.

## Source Repository
- `/home/steelburn/Development/Roo-Code` (cloned, Apache 2.0)
- Our project: `/home/steelburn/Development/vscode/ado-code`

## Phase 1: Core Architecture (Foundation)

### Task 1.1: BaseTool Abstract Class
- **Source:** `Roo-Code/src/core/tools/BaseTool.ts` (162 lines)
- **Target:** `src/llm/tools/BaseTool.ts`
- **What:** Abstract class with typed params, streaming support, callbacks
- **Dependencies:** None
- **Tier:** Critical (core logic)

### Task 1.2: Tool Callbacks & Types
- **Source:** `Roo-Code/src/shared/tools.ts` (lines 1-100)
- **Target:** `src/llm/tools/types.ts` (extend existing)
- **What:** AskApproval, HandleError, PushToolResult, ToolCallbacks interfaces
- **Dependencies:** Task 1.1
- **Tier:** Critical (type foundation)

### Task 1.3: Native Tool Definitions
- **Source:** `Roo-Code/src/core/prompts/tools/native-tools/` (index.ts + individual tools)
- **Target:** `src/llm/tools/definitions/` (new directory)
- **What:** Tool definitions as OpenAI.Chat.ChatCompletionTool objects
- **Dependencies:** Task 1.2
- **Tier:** Critical (tool calling foundation)

### Task 1.4: BaseProvider Abstract Class
- **Source:** `Roo-Code/src/api/providers/base-provider.ts` (122 lines)
- **Target:** `src/llm/providers/BaseProvider.ts`
- **What:** Abstract class with createMessage, getModel, countTokens
- **Dependencies:** None
- **Tier:** Critical (API abstraction)

### Task 1.5: ApiHandler Interface & Factory
- **Source:** `Roo-Code/src/api/index.ts` (183 lines)
- **Target:** `src/llm/handler.ts` (new file)
- **What:** ApiHandler interface, buildApiHandler factory, ApiStream type
- **Dependencies:** Task 1.4
- **Tier:** Critical (API factory)

### Task 1.6: ContextProxy Configuration System
- **Source:** `Roo-Code/src/core/config/ContextProxy.ts` (575 lines, adapt subset)
- **Target:** `src/config/ContextProxy.ts`
- **What:** Cached, typed access to VS Code globalState/secrets
- **Dependencies:** None
- **Tier:** Standard (config infrastructure)

## Phase 2: Tool Implementations

### Task 2.1: ReadFileTool
- **Source:** `Roo-Code/src/core/tools/ReadFileTool.ts` (813 lines, adapt)
- **Target:** `src/llm/tools/ReadFileTool.ts`
- **What:** File reading with slice/indentation modes
- **Dependencies:** Tasks 1.1, 1.2
- **Tier:** Standard

### Task 2.2: SearchFilesTool
- **Source:** `Roo-Code/src/core/tools/SearchFilesTool.ts`
- **Target:** `src/llm/tools/SearchFilesTool.ts`
- **What:** File content search with regex
- **Dependencies:** Tasks 1.1, 1.2
- **Tier:** Standard

### Task 2.3: EditFileTool
- **Source:** `Roo-Code/src/core/tools/EditFileTool.ts`
- **Target:** `src/llm/tools/EditFileTool.ts`
- **What:** File editing with search/replace
- **Dependencies:** Tasks 1.1, 1.2
- **Tier:** Standard

### Task 2.4: ExecuteCommandTool
- **Source:** `Roo-Code/src/core/tools/ExecuteCommandTool.ts`
- **Target:** `src/llm/tools/ExecuteCommandTool.ts`
- **What:** Shell command execution with approval
- **Dependencies:** Tasks 1.1, 1.2
- **Tier:** Standard

### Task 2.5: ListFilesTool
- **Source:** `Roo-Code/src/core/tools/ListFilesTool.ts`
- **Target:** `src/llm/tools/ListFilesTool.ts`
- **What:** Directory listing with recursive option
- **Dependencies:** Tasks 1.1, 1.2
- **Tier:** Standard

## Phase 3: Provider Upgrade

### Task 3.1: Refactor OpenAI Provider
- **Source:** `Roo-Code/src/api/providers/openai-native.ts` (adapt)
- **Target:** `src/llm/providers/openai.ts` (refactor existing)
- **What:** Extend BaseProvider, add streaming, tool calling
- **Dependencies:** Tasks 1.4, 1.5
- **Tier:** Critical (core API)

### Task 3.2: Refactor Anthropic Provider
- **Source:** `Roo-Code/src/api/providers/anthropic.ts` (adapt)
- **Target:** `src/llm/providers/anthropic.ts` (refactor existing)
- **What:** Extend BaseProvider, add streaming, tool calling
- **Dependencies:** Tasks 1.4, 1.5
- **Tier:** Critical (core API)

## Phase 4: Integration

### Task 4.1: Wire Tools into Agentic Loop
- **Source:** `Roo-Code/src/core/task/Task.ts` (adapt patterns)
- **Target:** `src/llm/agentic.ts` (refactor existing)
- **What:** Use tool registry, dispatch to tool instances, handle approval
- **Dependencies:** Tasks 1.1-2.5, 3.1-3.2
- **Tier:** Critical (integration)

### Task 4.2: Tool Approval UI
- **Source:** `Roo-Code/src/core/auto-approval/` (adapt patterns)
- **Target:** `src/llm/consent.ts` (extend existing)
- **What:** Tool-level approval for read/write/execute
- **Dependencies:** Task 4.1
- **Tier:** Standard

## Review Checklist (per task)

- [ ] Spec compliance: all requirements implemented
- [ ] Follows project conventions (TypeScript strict, ES modules)
- [ ] Proper error handling with descriptive messages
- [ ] Type safety: no `any` types where avoidable
- [ ] Tests: at least one test covering the happy path
- [ ] No scope creep: only what's in the spec
- [ ] Builds clean: `npm run compile` passes
- [ ] Lints clean: `npm run lint` passes

## Verification Commands
```bash
npm run compile        # TypeScript compilation
npm run lint           # ESLint
npm test               # Mocha tests
npm run build:webview  # Webview build
vsce package --allow-missing-repository  # Package extension
```
