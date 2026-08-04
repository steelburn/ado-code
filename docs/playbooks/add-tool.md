# Playbook: Adding a New Tool

How to add a new native tool to ADO Code's tool system.

## Overview

Tools are OpenAI function-calling compatible definitions paired with
`BaseTool` implementations. There are two layers:

1. **Tool definition** (`src/llm/tools/definitions/`) — the JSON Schema
   that gets sent to the LLM API
2. **Tool implementation** (`src/llm/tools/`) — the `BaseTool` subclass
   that actually runs the tool

## Steps

### 1. Create the tool definition

Create a new file in `src/llm/tools/definitions/`:

```typescript
// src/llm/tools/definitions/my_tool.ts
import type { ToolDefinition } from './types'

const MY_TOOL_DESCRIPTION = `Description of what the tool does.
Include parameter docs and usage examples here.

Parameters:
- param1: (required) What param1 does
- param2: (optional) What param2 does`

const my_tool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'my_tool',
    description: MY_TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        param1: {
          type: 'string',
          description: 'What param1 does',
        },
        param2: {
          type: 'number',
          description: 'What param2 does',
        },
      },
      required: ['param1'],
      additionalProperties: false,
    },
  },
}

export default my_tool
```

### 2. Register in the definitions index

Add the import and export in `src/llm/tools/definitions/index.ts`:

```typescript
import my_tool from './my_tool'

export { default as my_tool } from './my_tool'

export const ALL_NATIVE_TOOLS = [
  // ... existing tools ...
  my_tool,
]
```

### 3. Add to the ToolName union

In `src/llm/tools/types.ts`, add the tool name:

```typescript
export type ToolName =
  | 'read_file'
  // ... existing names ...
  | 'my_tool'
```

Add the typed params:

```typescript
export interface NativeToolArgs {
  // ... existing entries ...
  my_tool: { param1: string; param2?: number }
}
```

Add the display name:

```typescript
export const TOOL_DISPLAY_NAMES: Record<ToolName, string> = {
  // ... existing entries ...
  my_tool: 'My tool',
}
```

Add to the appropriate tool group:

```typescript
export const TOOL_GROUP_MAP: ToolGroupMap = {
  read: [/* ... */],
  write: [/* ... */],
  // Add to the right group, e.g.:
  mcp: ['my_tool'],
}
```

### 4. Create the BaseTool implementation

Create `src/llm/tools/MyToolTool.ts`:

```typescript
import { BaseTool, type TaskLike, type ToolCallbacks } from "./BaseTool"
import type { NativeToolArgs } from "./types"

type MyToolParams = NativeToolArgs["my_tool"]

export class MyToolTool extends BaseTool {
  readonly name = "my_tool" as const

  async execute(
    params: Record<string, unknown>,
    task: TaskLike,
    callbacks: ToolCallbacks,
  ): Promise<void> {
    const { pushToolResult, toolCallId } = callbacks
    try {
      const typedParams = params as unknown as MyToolParams

      // Validate required params
      if (!typedParams.param1) {
        pushToolResult(toolCallId, "Error: missing required parameter 'param1'")
        return
      }

      // Do the work
      const result = `Executed my_tool with param1=${typedParams.param1}`
      pushToolResult(toolCallId, result)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      pushToolResult(toolCallId, `Error: ${msg}`)
    } finally {
      this.resetPartialState()
    }
  }

  // Optional: override handlePartial() for streaming UI updates
  override async handlePartial(
    task: TaskLike,
    block: { id: string; name: string; params: Record<string, unknown>; partial: boolean },
  ): Promise<void> {
    // Show streaming status to user
  }
}

export const myToolTool = new MyToolTool()
```

### 5. Register in ToolRegistry

In `src/llm/tools/ToolRegistry.ts`, the `registerBuiltInTools()` method
should register your new tool instance:

```typescript
import { myToolTool } from './MyToolTool'

// In registerBuiltInTools():
this.register(myToolTool)
```

### 6. Add to the ToolExecutor switch (if needed)

For tools used in the agentic loop via `createToolExecutor` in
`src/llm/tools.ts`:

1. Add the tool to the `tools` array with its `LlmTool` definition
2. Classify it as read-only or mutating:
   - Add to `READ_ONLY_TOOLS` for non-mutating tools
   - Add to `MUTATING_TOOLS` for tools that change state
3. Add a `case` in the `switch (name)` block to handle execution

### 7. Write tests

Create `src/test/suite/llm/myTool.test.ts`:

```typescript
import * as assert from 'assert'
import { MyToolTool } from '../../../llm/tools/MyToolTool'

suite('MyToolTool', () => {
  const tool = new MyToolTool()

  test('has correct name', () => {
    assert.strictEqual(tool.name, 'my_tool')
  })

  test('execute returns result', async () => {
    // Mock task and callbacks
    const result = await tool.execute(
      { param1: 'hello' },
      { cwd: '/tmp', api: null, say: async () => {} },
      {
        toolCallId: 'test-1',
        pushToolResult: (id, content) => { /* capture */ },
        handleError: async () => {},
        taskApproval: async () => true,
      },
    )
    // Assert result
  })
})
```

## Pitfalls

- **Tool name uniqueness**: `ToolRegistry.register()` throws if a tool with
  the same name is already registered. Check `ToolName` union for conflicts.
- **Path confinement**: File tools must use `resolveWorkspacePath()` to
  prevent `../` escapes (C4 security fix).
- **Mode gating**: Mutating tools are blocked in plan mode. Always
  classify your tool correctly in `READ_ONLY_TOOLS` or `MUTATING_TOOLS`.
- **Binary data**: Use `callbacks.pushToolResult()` with `string` for
  tool output, never throw (agentic-loop safety — throws kill the loop).

## File Checklist

| File | Action |
|------|--------|
| `src/llm/tools/definitions/my_tool.ts` | Create |
| `src/llm/tools/definitions/index.ts` | Edit (import + register) |
| `src/llm/tools/types.ts` | Edit (ToolName, NativeToolArgs, display name, group) |
| `src/llm/tools/MyToolTool.ts` | Create |
| `src/llm/tools/ToolRegistry.ts` | Edit (register in built-ins) |
| `src/llm/tools.ts` | Edit (if using createToolExecutor path) |
| `src/test/suite/llm/myTool.test.ts` | Create |
