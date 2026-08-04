# MCP Integration & Checkpoint System Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add optional MCP (Model Context Protocol) client support for external tool servers, and a file-level checkpoint system that saves/restores workspace files before AI edits.

**Architecture:** Two independent services added to the composition root (`src/services.ts`). MCP client spawns child processes for stdio-based MCP servers and bridges their tools into the agentic loop. Checkpoint service snapshots files to a `.ado-code/checkpoints/` directory before each mutating tool call and can restore them.

**Tech Stack:** TypeScript, child_process (MCP), fs/promises (checkpoints), existing ToolExecutor pattern.

---

## Phase A: Checkpoint System (Task 9.1 from original plan)

### Task A1: Create checkpoint types and service

**Objective:** Implement a simple file-level checkpoint service that saves/restores workspace file contents.

**Files:**
- Create: `src/services/checkpoints/types.ts`
- Create: `src/services/checkpoints/CheckpointService.ts`
- Create: `src/test/suite/checkpoints/checkpointService.test.ts`

**What:** 
- `CheckpointService` class with methods: `save(taskId, filePaths)`, `restore(checkpointId)`, `listCheckpoints(taskId)`, `getCheckpointDiff(checkpointId)`
- Checkpoints stored in `<workspace>/.ado-code/checkpoints/<taskId>/<timestamp>/`
- Each checkpoint is a JSON manifest (`manifest.json`) mapping file paths to their saved contents (base64-encoded for binary safety)
- Max checkpoints per task: 50 (FIFO eviction)

**Implementation:**

Create `src/services/checkpoints/types.ts`:
```typescript
export interface CheckpointManifest {
  id: string;
  taskId: string;
  timestamp: number;
  files: Record<string, string>; // relative path → base64 content
}

export interface CheckpointDiff {
  filePath: string;
  status: 'added' | 'removed' | 'modified' | 'unchanged';
  before?: string;
  after?: string;
}
```

Create `src/services/checkpoints/CheckpointService.ts`:
```typescript
import * as fs from 'fs/promises';
import * as path from 'path';
import type { CheckpointManifest, CheckpointDiff } from './types';

export class CheckpointService {
  private readonly checkpointsRoot: string;

  constructor(workspaceDir: string) {
    this.checkpointsRoot = path.join(workspaceDir, '.ado-code', 'checkpoints');
  }

  async save(taskId: string, filePaths: string[]): Promise<string> {
    const taskDir = path.join(this.checkpointsRoot, taskId);
    await fs.mkdir(taskDir, { recursive: true });

    const files: Record<string, string> = {};
    for (const rel of filePaths) {
      try {
        const abs = path.join(/* workspaceRoot */, rel);
        const content = await fs.readFile(abs);
        files[rel] = content.toString('base64');
      } catch { /* file may not exist yet — skip */ }
    }

    const id = `${Date.now()}`;
    const manifest: CheckpointManifest = { id, taskId, timestamp: Date.now(), files };
    await fs.writeFile(path.join(taskDir, `${id}.json`), JSON.stringify(manifest, null, 2));

    // Evict old checkpoints beyond limit
    await this.evictOld(taskDir, 50);

    return id;
  }

  async restore(checkpointId: string, taskId: string): Promise<string[]> {
    const manifest = await this.readManifest(checkpointId, taskId);
    const restored: string[] = [];
    for (const [rel, b64] of Object.entries(manifest.files)) {
      const abs = path.join(/* workspaceRoot */, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, Buffer.from(b64, 'base64'));
      restored.push(rel);
    }
    return restored;
  }

  async listCheckpoints(taskId: string): Promise<CheckpointManifest[]> { ... }
  async getDiff(checkpointId: string, taskId: string): Promise<CheckpointDiff[]> { ... }
  async deleteCheckpoint(checkpointId: string, taskId: string): Promise<void> { ... }

  private async evictOld(taskDir: string, maxCount: number) { ... }
  private async readManifest(id: string, taskId: string): Promise<CheckpointManifest> { ... }
}
```

**Step 1:** Write tests first (TDD)
**Step 2:** Implement CheckpointService
**Step 3:** Run: `npm run compile && npm test`
**Step 4:** Commit: `feat: add checkpoint service for file save/restore`

---

### Task A2: Wire checkpoints into the ToolExecutor

**Objective:** Automatically save checkpoints before mutating tool calls and expose a `restore_checkpoint` tool.

**Files:**
- Modify: `src/llm/tools.ts` (add restore_checkpoint tool, save before mutations)
- Modify: `src/services.ts` (add checkpoints to Services)

**What:**
- Add `restore_checkpoint` tool definition to the tool list
- Before executing mutating tools (`edit_file`, `write_to_file`, `apply_diff`, `run_terminal_command`), auto-save a checkpoint of the affected files
- Add `checkpoints: CheckpointService` to the `Services` interface
- Wire it up in `createServices()`

---

## Phase B: MCP Client Wrapper (Task 8.1 from original plan)

### Task B1: Create MCP types and simplified client

**Objective:** Implement a lightweight MCP client that connects to stdio-based MCP servers and discovers their tools.

**Files:**
- Create: `src/services/mcp/types.ts`
- Create: `src/services/mcp/McpClient.ts`
- Create: `src/test/suite/mcp/mcpClient.test.ts`

**What:**
- `McpServerConfig` type (command, args, env, timeout)
- `McpClient` class that spawns a child process, sends JSON-RPC over stdin/stdout, and discovers tools
- Supports: `initialize`, `tools/list`, `tools/call`
- Returns tools in `LlmTool` format for direct registration with the ToolExecutor

**Implementation approach:**
- Use `child_process.spawn` with JSON-RPC 2.0 over stdio (line-delimited JSON)
- Send `initialize` handshake on connect
- Send `tools/list` to discover available tools
- `callTool(name, args)` sends `tools/call` and returns the result
- Timeout on all operations (default 30s)
- Reconnection is NOT implemented (keep it simple — reconnect manually)

Create `src/services/mcp/types.ts`:
```typescript
export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeout?: number; // ms, default 30000
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

export interface McpToolCallResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
}
```

Create `src/services/mcp/McpClient.ts`:
```typescript
import { ChildProcess, spawn } from 'child_process';
import type { McpServerConfig, McpToolInfo, McpToolCallResult } from './types';
import type { LlmTool } from '../../llm/types';

export class McpClient {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pending = new Map<number, { resolve: Function; reject: Function }>();
  private buffer = '';

  constructor(private config: McpServerConfig) {}

  async connect(): Promise<void> { /* spawn + initialize handshake */ }
  async listTools(): Promise<McpToolInfo[]> { /* tools/list */ }
  async callTool(name: string, args: Record<string, any>): Promise<McpToolCallResult> { /* tools/call */ }
  async toLlmTools(): Promise<LlmTool[]> { /* convert McpToolInfo[] → LlmTool[] */ }
  async disconnect(): Promise<void> { /* kill process */ }

  private send(method: string, params?: any): Promise<any> { /* JSON-RPC */ }
  private onData(data: Buffer): void { /* parse JSON-RPC responses */ }
}
```

**Step 1:** Write tests (mock child_process)
**Step 2:** Implement McpClient
**Step 3:** Run: `npm run compile && npm test`
**Step 4:** Commit: `feat: add MCP client for external tool servers`

---

### Task B2: Create MCP manager and wire into services

**Objective:** Add an MCP manager that manages multiple server connections and bridges their tools into the ToolExecutor.

**Files:**
- Create: `src/services/mcp/McpManager.ts`
- Modify: `src/services.ts` (add mcp to Services)
- Modify: `src/llm/tools.ts` (add mcp tool prefix, expose call_mcp_tool)

**What:**
- `McpManager` holds multiple `McpClient` instances
- Loads server configs from VS Code settings (`adoCode.mcp.servers`)
- `connectAll()` / `disconnectAll()` lifecycle
- `getMcpTools()` returns all discovered tools with `mcp__<server>__<tool>` naming
- Wire into ToolExecutor as `call_mcp_tool` tool

Add VS Code config for MCP servers:
```json
"adoCode.mcp.servers": {
  "type": "array",
  "default": [],
  "description": "MCP servers to connect to: [{ \"name\": \"myserver\", \"command\": \"npx\", \"args\": [\"-y\", \"@myorg/mcp-server\"] }]"
}
```

---

### Task B3: Final integration and cleanup

**Objective:** Verify everything compiles and tests pass together.

**Files:**
- Verify all changes compile
- Run full test suite
- Update CHANGELOG.md

**Step 1:** `npm run compile` — must be clean
**Step 2:** `npm test` — all 66+ tests passing
**Step 3:** `npm run build:webview` — webview still builds
**Step 4:** Commit: `chore: integrate MCP and checkpoint systems`
