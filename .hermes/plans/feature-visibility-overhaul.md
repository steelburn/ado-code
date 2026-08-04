# Feature Visibility Overhaul — Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make all invisible features (memory, MCP, checkpoints, context, modes) visible to users through an Output channel, a Status panel tree view, memory browser commands, and a token usage indicator.

**Architecture:** Add a shared Logger utility wrapping a VS Code OutputChannel. Add a new `adoCode.status` tree view that surfaces at-a-glance state for all subsystems. Add VS Code commands for memory management. Fix MCP activation. Add token usage status bar item. All changes wire into the existing `Services` interface and `extension.ts` activation flow.

**Tech Stack:** TypeScript, VS Code Extension API (TreeDataProvider, OutputChannel, StatusBar), existing services (UserMemory, WorkspaceMemory, McpManager, CheckpointService, ContextManager).

---

## Batch 1: Output Channel + Logger Utility

### Task 1.1: Create Logger utility

**Objective:** Create a singleton Logger class wrapping `vscode.window.createOutputChannel()`.

**Files:**
- Create: `src/services/logger.ts`

**Step 1: Write the Logger class**

```typescript
import * as vscode from 'vscode';

export enum LogLevel {
  Info = 'INFO',
  Warn = 'WARN',
  Error = 'ERROR',
  Debug = 'DEBUG',
}

class Logger {
  private channel?: vscode.OutputChannel;

  activate(context: vscode.ExtensionContext): void {
    this.channel = vscode.window.createOutputChannel('ADO Code');
    context.subscriptions.push(this.channel);
    this.info('Extension activated');
  }

  private log(level: LogLevel, message: string, data?: unknown): void {
    if (!this.channel) return;
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level}]`;
    this.channel.appendLine(`${prefix} ${message}`);
    if (data !== undefined) {
      const json = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      this.channel.appendLine(json);
    }
  }

  info(message: string, data?: unknown): void { this.log(LogLevel.Info, message, data); }
  warn(message: string, data?: unknown): void { this.log(LogLevel.Warn, message, data); }
  error(message: string, data?: unknown): void { this.log(LogLevel.Error, message, data); }
  debug(message: string, data?: unknown): void { this.log(LogLevel.Debug, message, data); }

  getChannel(): vscode.OutputChannel | undefined { return this.channel; }
}

export const logger = new Logger();
```

**Step 2: Verify it compiles**

Run: `npm run compile`
Expected: clean, no errors

**Step 3: Commit**

```bash
git add src/services/logger.ts
git commit -m "feat: add Logger utility with VS Code OutputChannel"
```

---

### Task 1.2: Register Logger in extension activation

**Objective:** Call `logger.activate(context)` at the top of `activate()` so the Output channel is ready before any service logs.

**Files:**
- Modify: `src/extension.ts:19` (after `createServices`)

**Step 1: Import and activate logger**

In `src/extension.ts`, add at top of imports:
```typescript
import { logger } from './services/logger';
```

At the start of `activate(context)`, before `createServices`:
```typescript
logger.activate(context);
```

**Step 2: Verify it compiles**

Run: `npm run compile`
Expected: clean

**Step 3: Commit**

```bash
git add src/extension.ts
git commit -m "feat: register Logger in extension activation"
```

---

### Task 1.3: Wire Logger into Services interface

**Objective:** Add logger to the Services interface so all services can log.

**Files:**
- Modify: `src/services.ts` (Services interface + createServices)

**Step 1: Add logger to Services interface**

```typescript
import { logger, Logger } from './services/logger';

export interface Services {
  ado: AdoClient;
  git: GitService;
  changelog: ChangelogService;
  agents: AgentRegistry;
  checkpoints: CheckpointService;
  mcp: McpManager;
  workspaceMemory: WorkspaceMemory;
  memory: UserMemory;
  logger: typeof logger;  // singleton
}
```

**Step 2: Add logger to createServices return**

```typescript
return {
  // ... existing services
  logger,
};
```

**Step 3: Verify it compiles**

Run: `npm run compile`
Expected: clean

**Step 4: Commit**

```bash
git add src/services.ts
git commit -m "feat: add logger to Services interface"
```

---

### Task 1.4: Add logging to MCP activation (and fix the bug)

**Objective:** Add `logger.info/debug` calls throughout McpManager and fix the missing `connectAll()` call.

**Files:**
- Modify: `src/services/mcp/McpManager.ts` (add logging to connectAll, disconnectAll, callTool)
- Modify: `src/extension.ts` (call `services.mcp.connectAll()` after createServices)

**Step 1: Add logging to McpManager**

In `McpManager.ts`, import logger and add calls:

```typescript
import { logger } from '../logger';
```

In `connectAll()`:
```typescript
async connectAll(): Promise<void> {
  logger.info('MCP: connecting all servers...');
  // ... existing logic ...
  for (const server of servers) {
    logger.info(`MCP: connecting to ${server.name}...`);
    // ... connect ...
    logger.info(`MCP: connected to ${server.name} (${tools.length} tools)`);
  }
  logger.info(`MCP: all servers connected. Total tools: ${totalTools}`);
}
```

In `callTool()`:
```typescript
logger.debug(`MCP: callTool ${prefixedName}`, args);
// ... existing logic ...
logger.debug(`MCP: callTool ${prefixedName} completed`);
```

In `disconnectAll()`:
```typescript
logger.info('MCP: disconnecting all servers...');
// ...
logger.info('MCP: all servers disconnected');
```

**Step 2: Call connectAll() in extension.ts**

In `activate()`, after `createServices(context)` and the `services.mcp` line:

```typescript
// Connect MCP servers
services.mcp.connectAll().catch(err => {
  logger.error('MCP: failed to connect servers', err);
});
```

**Step 3: Verify it compiles**

Run: `npm run compile`
Expected: clean

**Step 4: Commit**

```bash
git add src/services/mcp/McpManager.ts src/extension.ts
git commit -m "feat: add logging to MCP and fix missing connectAll() call"
```

---

### Task 1.5: Add logging to other services

**Objective:** Add logger calls to key operations across services.

**Files:**
- Modify: `src/memory/UserMemory.ts`
- Modify: `src/memory/WorkspaceMemory.ts`
- Modify: `src/services/checkpoints/CheckpointService.ts`
- Modify: `src/webview/ChatViewProvider.ts` (memory injection, context condensation)

**Step 1: Add logging to UserMemory**

```typescript
import { logger } from '../services/logger';

// In set():
logger.info(`Memory: set "${key}" (${category})`);

// In delete():
logger.info(`Memory: deleted "${key}"`);

// In clear():
logger.info('Memory: cleared all user memory');
```

**Step 2: Add logging to WorkspaceMemory**

```typescript
import { logger } from '../services/logger';

// In write():
logger.info(`WorkspaceMemory: write "${key}"`);

// In delete():
logger.info(`WorkspaceMemory: deleted "${key}"`);
```

**Step 3: Add logging to CheckpointService**

```typescript
import { logger } from '../logger';

// In save():
logger.info(`Checkpoint: saved ${filePaths.length} files as ${id}`);

// In restore():
logger.info(`Checkpoint: restored ${restored.length} files from ${checkpointId}`);
```

**Step 4: Add logging to ChatViewProvider for context events**

In the agentic chat turn method (around line 757):
```typescript
logger.debug(`Chat: building system prompt with ${this.services.memory.getAll().length} user memories, ${this.services.workspaceMemory.list().length} workspace memories`);
```

After context condensation (if it happens):
```typescript
logger.info(`Context: condensation triggered, ${removedCount} messages condensed`);
```

**Step 5: Verify it compiles**

Run: `npm run compile`
Expected: clean

**Step 6: Commit**

```bash
git add src/memory/UserMemory.ts src/memory/WorkspaceMemory.ts src/services/checkpoints/CheckpointService.ts src/webview/ChatViewProvider.ts
git commit -m "feat: add logging to memory, checkpoints, and context systems"
```

---

## Batch 2: Status Panel (Tree View)

### Task 2.1: Create StatusPanelProvider

**Objective:** A TreeDataProvider that shows at-a-glance status for all subsystems.

**Files:**
- Create: `src/webview/StatusPanelProvider.ts`

**Step 1: Write the StatusPanelProvider**

```typescript
import * as vscode from 'vscode';
import { Services } from '../services';
import { getSettings } from '../config/settings';

export class StatusPanelProvider implements vscode.TreeDataProvider<StatusItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<StatusItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private services: Services) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: StatusItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: StatusItem): StatusItem[] {
    if (element) return element.children ?? [];

    const items: StatusItem[] = [];

    // Mode
    const settings = getSettings();
    items.push(new StatusItem(
      `Mode: ${settings.mode}`,
      vscode.TreeItemCollapsibleState.None,
      { command: 'adoCode.setMode', title: 'Change Mode' }
    ));
    items[items.length - 1].iconPath = new vscode.ThemeIcon('compass');

    // Memory
    const userMemories = this.services.memory.getAll();
    const workspaceMemories = this.services.workspaceMemory.list();
    const memItem = new StatusItem(
      `Memory: ${userMemories.length} user, ${workspaceMemories.length} workspace`,
      vscode.TreeItemCollapsibleState.Expanded
    );
    memItem.iconPath = new vscode.ThemeIcon('brain');
    for (const entry of userMemories) {
      const child = new StatusItem(
        `[${entry.category}] ${entry.key}: ${entry.content.substring(0, 60)}`,
        vscode.TreeItemCollapsibleState.None
      );
      child.iconPath = new vscode.ThemeIcon('person');
      child.description = new Date(entry.timestamp).toLocaleDateString();
      memItem.children = memItem.children ?? [];
      memItem.children.push(child);
    }
    for (const key of workspaceMemories) {
      const child = new StatusItem(key, vscode.TreeItemCollapsibleState.None);
      child.iconPath = new vscode.ThemeIcon('folder');
      memItem.children = memItem.children ?? [];
      memItem.children.push(child);
    }
    items.push(memItem);

    // MCP
    const mcpServers = this.services.mcp.getConnectedServers();
    const mcpItem = new StatusItem(
      `MCP: ${mcpServers.length} server(s) connected`,
      vscode.TreeItemCollapsibleState.Expanded
    );
    mcpItem.iconPath = new vscode.ThemeIcon('plug');
    for (const name of mcpServers) {
      const child = new StatusItem(name, vscode.TreeItemCollapsibleState.None);
      child.iconPath = new vscode.ThemeIcon('check');
      mcpItem.children = mcpItem.children ?? [];
      mcpItem.children.push(child);
    }
    if (mcpServers.length === 0) {
      const child = new StatusItem('No servers connected', vscode.TreeItemCollapsibleState.None);
      child.description = 'Configure adoCode.mcp.servers';
      mcpItem.children = mcpItem.children ?? [];
      mcpItem.children.push(child);
    }
    items.push(mcpItem);

    // Agents
    const agentItem = new StatusItem(
      'Agents',
      vscode.TreeItemCollapsibleState.Expanded
    );
    agentItem.iconPath = new vscode.ThemeIcon('hubot');
    // AgentRegistry.detect() is sync — reads PATH
    const agents = this.services.agents.detect();
    for (const agent of agents) {
      const child = new StatusItem(agent.name, vscode.TreeItemCollapsibleState.None);
      child.iconPath = agent.installed
        ? new vscode.ThemeIcon('check')
        : new vscode.ThemeIcon('close');
      child.description = agent.installed ? 'installed' : 'not found';
      agentItem.children = agentItem.children ?? [];
      agentItem.children.push(child);
    }
    items.push(agentItem);

    // Checkpoints (placeholder — needs taskId context)
    const cpItem = new StatusItem(
      'Checkpoints: (start a task to see)',
      vscode.TreeItemCollapsibleState.None
    );
    cpItem.iconPath = new vscode.ThemeIcon('history');
    items.push(cpItem);

    return items;
  }
}

class StatusItem extends vscode.TreeItem {
  children?: StatusItem[];
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    openCommand?: vscode.Command
  ) {
    super(label, collapsibleState);
    if (openCommand) this.command = openCommand;
  }
}
```

**Step 2: Verify it compiles**

Run: `npm run compile`
Expected: clean (may need minor type fixes)

**Step 3: Commit**

```bash
git add src/webview/StatusPanelProvider.ts
git commit -m "feat: add StatusPanelProvider tree view"
```

---

### Task 2.2: Register Status Panel in package.json

**Objective:** Add the new tree view to the ADO Code sidebar.

**Files:**
- Modify: `package.json` (views section)

**Step 1: Add view to views array**

In `package.json`, add to the `adoCode` views array:

```json
{
  "id": "adoCode.status",
  "name": "Status",
  "type": "tree"
}
```

**Step 2: Add refresh command**

Add to `contributes.commands`:

```json
{
  "command": "adoCode.refreshStatus",
  "title": "Refresh Status",
  "icon": "$(refresh)",
  "category": "ADO Code"
}
```

**Step 3: Verify it compiles**

Run: `npm run compile`
Expected: clean

**Step 4: Commit**

```bash
git add package.json
git commit -m "feat: register Status view in package.json"
```

---

### Task 2.3: Wire StatusPanelProvider in extension.ts

**Objective:** Instantiate and register the StatusPanelProvider.

**Files:**
- Modify: `src/extension.ts`

**Step 1: Import and instantiate**

```typescript
import { StatusPanelProvider } from './webview/StatusPanelProvider';

// After ChatViewProvider registration:
const statusProvider = new StatusPanelProvider(services);
context.subscriptions.push(
  vscode.window.registerTreeDataProvider('adoCode.status', statusProvider)
);

// Register refresh command
context.subscriptions.push(
  vscode.commands.registerCommand('adoCode.refreshStatus', () => {
    statusProvider.refresh();
  })
);
```

**Step 2: Auto-refresh on relevant events**

After memory/checkpoint/mcp operations, call `statusProvider.refresh()`. To do this, expose a refresh callback through Services or use an event emitter. For now, refresh on:
- `onDidChangeConfiguration` (already exists at line 385)
- After agent run completes (AgentRunner callback)

Add to the existing `onDidChangeConfiguration` handler:
```typescript
statusProvider.refresh();
```

**Step 3: Verify it compiles**

Run: `npm run compile`
Expected: clean

**Step 4: Commit**

```bash
git add src/extension.ts
git commit -m "feat: wire StatusPanelProvider in extension activation"
```

---

### Task 2.4: Add tests for StatusPanelProvider

**Objective:** Verify the tree provider returns correct items.

**Files:**
- Create: `src/test/suite/status/statusPanel.test.ts`

**Step 1: Write tests**

```typescript
import * as assert from 'assert';
import { StatusPanelProvider } from '../../../webview/StatusPanelProvider';
import { createMockServices } from '../../helpers';

suite('StatusPanelProvider', () => {
  test('getChildren returns top-level items', () => {
    const services = createMockServices();
    const provider = new StatusPanelProvider(services as any);
    const children = provider.getChildren();
    assert.ok(children.length >= 4, 'Should have at least 4 top-level items (mode, memory, mcp, agents)');
  });

  test('memory section shows user and workspace counts', () => {
    const services = createMockServices();
    services.memory.getAll = () => [
      { key: 'test', category: 'preference', content: 'value', timestamp: '2026-01-01' }
    ];
    services.workspaceMemory.list = () => ['proj-conv'];
    const provider = new StatusPanelProvider(services as any);
    const children = provider.getChildren();
    const memItem = children.find(c => c.label.toString().includes('Memory'));
    assert.ok(memItem, 'Should have memory item');
    assert.ok(memItem.label.toString().includes('1 user'), 'Should show 1 user memory');
    assert.ok(memItem.label.toString().includes('1 workspace'), 'Should show 1 workspace memory');
  });
});
```

**Step 2: Run tests**

Run: `npm test`
Expected: new tests pass

**Step 3: Commit**

```bash
git add src/test/suite/status/statusPanel.test.ts
git commit -m "test: add StatusPanelProvider tests"
```

---

## Batch 3: Memory Browser Commands

### Task 3.1: Add memory commands to package.json

**Objective:** Register VS Code commands for viewing, editing, and clearing memory.

**Files:**
- Modify: `package.json` (commands section)

**Step 1: Add commands**

```json
{ "command": "adoCode.showMemory", "title": "Show Memory", "category": "ADO Code" },
{ "command": "adoCode.editMemory", "title": "Edit Memory Entry…", "category": "ADO Code" },
{ "command": "adoCode.clearMemory", "title": "Clear All Memory", "category": "ADO Code" },
{ "command": "adoCode.showWorkspaceMemory", "title": "Show Workspace Memory", "category": "ADO Code" }
```

**Step 2: Verify it compiles**

Run: `npm run compile`
Expected: clean

**Step 3: Commit**

```bash
git add package.json
git commit -m "feat: add memory management commands to package.json"
```

---

### Task 3.2: Implement memory commands in extension.ts

**Objective:** Implement the 4 memory commands using QuickPick and InputBox.

**Files:**
- Modify: `src/extension.ts`

**Step 1: Implement commands**

```typescript
// Show Memory — QuickPick listing all user memory entries
context.subscriptions.push(
  vscode.commands.registerCommand('adoCode.showMemory', () => {
    const entries = services.memory.getAll();
    if (entries.length === 0) {
      vscode.window.showInformationMessage('No user memory entries stored.');
      return;
    }
    const items = entries.map(e => ({
      label: `${e.key}`,
      description: `[${e.category}]`,
      detail: e.content,
      entry: e,
    }));
    vscode.window.showQuickPick(items, {
      placeHolder: 'Select a memory entry to view',
      matchOnDescription: true,
      matchOnDetail: true,
    });
  })
);

// Edit Memory — InputBox to edit an existing entry
context.subscriptions.push(
  vscode.commands.registerCommand('adoCode.editMemory', async () => {
    const entries = services.memory.getAll();
    if (entries.length === 0) {
      vscode.window.showInformationMessage('No user memory entries to edit.');
      return;
    }
    const items = entries.map(e => ({
      label: `${e.key}`,
      description: `[${e.category}]`,
      entry: e,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a memory entry to edit',
    });
    if (!picked) return;

    const newContent = await vscode.window.showInputBox({
      prompt: `Edit memory "${picked.entry.key}"`,
      value: picked.entry.content,
    });
    if (newContent !== undefined) {
      services.memory.set(picked.entry.key, picked.entry.category, newContent);
      vscode.window.showInformationMessage(`Memory "${picked.entry.key}" updated.`);
    }
  })
);

// Clear Memory
context.subscriptions.push(
  vscode.commands.registerCommand('adoCode.clearMemory', async () => {
    const confirm = await vscode.window.showWarningMessage(
      'Clear all user memory entries?',
      { modal: true },
      'Clear'
    );
    if (confirm === 'Clear') {
      services.memory.clear();
      vscode.window.showInformationMessage('All user memory cleared.');
    }
  })
);

// Show Workspace Memory — QuickPick listing workspace memory keys
context.subscriptions.push(
  vscode.commands.registerCommand('adoCode.showWorkspaceMemory', () => {
    const keys = services.workspaceMemory.list();
    if (keys.length === 0) {
      vscode.window.showInformationMessage('No workspace memory entries.');
      return;
    }
    const items = keys.map(key => ({
      label: key,
      detail: services.workspaceMemory.read(key) ?? '',
    }));
    vscode.window.showQuickPick(items, {
      placeHolder: 'Select a workspace memory entry to view',
    });
  })
);
```

**Step 2: Verify it compiles**

Run: `npm run compile`
Expected: clean

**Step 3: Commit**

```bash
git add src/extension.ts
git commit -m "feat: implement memory management commands (show, edit, clear, workspace)"
```

---

### Task 3.3: Add memory tests

**Objective:** Test the memory commands work with mock services.

**Files:**
- Create: `src/test/suite/memory/memoryCommands.test.ts`

**Step 1: Write tests**

Test that:
- `showMemory` with empty memory shows info message
- `showMemory` with entries shows QuickPick
- `editMemory` updates entry content
- `clearMemory` with confirmation clears all
- `showWorkspaceMemory` lists workspace keys

**Step 2: Run tests**

Run: `npm test`
Expected: pass

**Step 3: Commit**

```bash
git add src/test/suite/memory/memoryCommands.test.ts
git commit -m "test: add memory command tests"
```

---

## Batch 4: Token Usage Indicator

### Task 4.1: Add status bar token usage item

**Objective:** Show a status bar item with current token usage when chatting.

**Files:**
- Modify: `src/extension.ts` (create status bar item)
- Modify: `src/webview/ChatViewProvider.ts` (update status bar on each turn)

**Step 1: Create status bar item in extension.ts**

```typescript
const tokenStatusBar = vscode.window.createStatusBarItem(
  vscode.StatusBarAlignment.Right,
  100
);
tokenStatusBar.text = '$(pulse) Tokens: —';
tokenStatusBar.tooltip = 'Token usage in current conversation';
tokenStatusBar.command = 'adoCode.showTokenUsage';
context.subscriptions.push(tokenStatusBar);

// Make it accessible to ChatViewProvider
chatProvider.setTokenStatusBar(tokenStatusBar);
```

**Step 2: Add setTokenStatusBar to ChatViewProvider**

```typescript
private tokenStatusBar?: vscode.StatusBarItem;

setTokenStatusBar(bar: vscode.StatusBarItem): void {
  this.tokenStatusBar = bar;
}
```

**Step 3: Update after each chat turn**

In the agentic chat turn method, after getting the response:

```typescript
if (this.tokenStatusBar && this.contextManager) {
  const stats = this.contextManager.getUsageStats();
  this.tokenStatusBar.text = `$(pulse) Tokens: ~${stats.used.toLocaleString()}/${(stats.used + stats.remaining).toLocaleString()}`;
  this.tokenStatusBar.tooltip = `Token usage: ~${stats.used.toLocaleString()} used, ${stats.remaining.toLocaleString()} remaining (${Math.round(stats.percentage)}%)`;
}
```

**Step 4: Add showTokenUsage command**

```typescript
context.subscriptions.push(
  vscode.commands.registerCommand('adoCode.showTokenUsage', () => {
    // Show detailed token info in output channel
    logger.info('Token Usage', {
      current: chatProvider.getTokenUsage(),
      mode: getSettings().mode,
    });
    logger.getChannel()?.show();
  })
);
```

**Step 5: Verify it compiles**

Run: `npm run compile`
Expected: clean

**Step 6: Commit**

```bash
git add src/extension.ts src/webview/ChatViewProvider.ts
git commit -m "feat: add token usage status bar item"
```

---

## Batch 5: Set Mode Command

### Task 5.1: Add setMode command

**Objective:** Allow changing mode from command palette.

**Files:**
- Modify: `package.json` (add command)
- Modify: `src/extension.ts` (implement)

**Step 1: Add command to package.json**

```json
{ "command": "adoCode.setMode", "title": "Set Mode…", "category": "ADO Code" }
```

**Step 2: Implement in extension.ts**

```typescript
context.subscriptions.push(
  vscode.commands.registerCommand('adoCode.setMode', async () => {
    const modes = [
      { label: 'Inline', value: 'inline', description: 'Direct code edits with consent' },
      { label: 'Plan', value: 'plan', description: 'Read-only planning, no edits' },
      { label: 'Act', value: 'act', description: 'Full auto-approve mode' },
    ];
    const picked = await vscode.window.showQuickPick(modes, {
      placeHolder: 'Select a mode',
    });
    if (picked) {
      const config = vscode.workspace.getConfiguration('adoCode');
      await config.update('mode', picked.value, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Mode set to ${picked.label}`);
      statusProvider.refresh();
    }
  })
);
```

**Step 3: Verify it compiles**

Run: `npm run compile`
Expected: clean

**Step 4: Commit**

```bash
git add src/extension.ts package.json
git commit -m "feat: add setMode command with QuickPick"
```

---

## Batch 6: Checkpoint Quick Pick

### Task 6.1: Add checkpoint browse/restore command

**Objective:** Let users list and restore checkpoints from command palette.

**Files:**
- Modify: `package.json` (add command)
- Modify: `src/extension.ts` (implement)

**Step 1: Add command to package.json**

```json
{ "command": "adoCode.listCheckpoints", "title": "List Checkpoints…", "category": "ADO Code" }
```

**Step 2: Implement in extension.ts**

```typescript
context.subscriptions.push(
  vscode.commands.registerCommand('adoCode.listCheckpoints', async () => {
    // Need a task ID — ask user or use current
    const taskId = await vscode.window.showInputBox({
      prompt: 'Enter task ID to list checkpoints for',
      placeHolder: 'task-id',
    });
    if (!taskId) return;

    const checkpoints = services.checkpoints.listCheckpoints(taskId);
    if (checkpoints.length === 0) {
      vscode.window.showInformationMessage('No checkpoints found for this task.');
      return;
    }

    const items = checkpoints.map(cp => ({
      label: cp.id,
      description: `${cp.files.length} files`,
      detail: new Date(cp.timestamp).toLocaleString(),
      checkpoint: cp,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a checkpoint to restore',
    });
    if (!picked) return;

    const confirm = await vscode.window.showWarningMessage(
      `Restore checkpoint ${picked.checkpoint.id}? This will overwrite current files.`,
      { modal: true },
      'Restore'
    );
    if (confirm === 'Restore') {
      const restored = services.checkpoints.restore(picked.checkpoint.id, taskId);
      vscode.window.showInformationMessage(`Restored ${restored.length} files from checkpoint.`);
      logger.info(`Checkpoint: restored ${restored.length} files from ${picked.checkpoint.id}`);
    }
  })
);
```

**Step 3: Verify it compiles**

Run: `npm run compile`
Expected: clean

**Step 4: Commit**

```bash
git add src/extension.ts package.json
git commit -m "feat: add listCheckpoints command with restore"
```

---

## Batch 7: Fix Slash Command Autocomplete Bug

### Task 7.1: Fix stale closure in handleKeyDown

**Objective:** The slash command dropdown ignores arrow-key navigation because `handleKeyDown` has a stale closure over `slashActiveIndex` and `slashMatches`.

**Root cause:** `handleKeyDown` is a `useCallback` (line 291) whose dependency array (line 381) is missing `showSlashDropdown`, `slashMatches`, `slashActiveIndex`, and `insertSlashCommand`. After arrow-key presses update `slashActiveIndex` via functional updater, the state changes but `handleKeyDown` is NOT recreated — so Enter always reads the stale index 0 (`/status`).

**Files:**
- Modify: `src/webview-ui/src/components/InputBar.tsx:381`

**Step 1: Add missing dependencies to useCallback**

Find the dependency array on line 381:
```typescript
}, [showMentionDropdown, mentionSuggestions, mentionActiveIndex, insertMention,
    handleSend, history, historyIndex, onValueChange]);
```

Replace with:
```typescript
}, [showMentionDropdown, mentionSuggestions, mentionActiveIndex, insertMention,
    showSlashDropdown, slashMatches, slashActiveIndex, insertSlashCommand,
    handleSend, history, historyIndex, onValueChange]);
```

**Step 2: Verify it compiles**

Run: `npm run compile`
Expected: clean

**Step 3: Manual test**

- Type `/` in chat input — dropdown appears
- ArrowDown 4 times to `/clear`
- Press Enter — should insert `/clear`, NOT `/status`

**Step 4: Commit**

```bash
git add src/webview-ui/src/components/InputBar.tsx
git commit -m "fix: add missing deps to handleKeyDown to fix slash command selection"
```

---

## Batch 8: Stop/Cancel Button

### Task 8.1: Add stopGeneration message type

**Objective:** Register a new message type for stopping LLM generation.

**Files:**
- Modify: `src/shared/messages.ts`

**Step 1: Add message type to WebviewToExtensionMessage**

Find the `WebviewToExtensionMessage` union type and add:
```typescript
| { type: 'stopGeneration' }
```

**Step 2: Verify it compiles**

Run: `npm run compile`
Expected: clean

**Step 3: Commit**

```bash
git add src/shared/messages.ts
git commit -m "feat: add stopGeneration message type"
```

---

### Task 8.2: Handle stopGeneration in ChatViewProvider

**Objective:** Abort the LLM stream and dismiss consent dialogs when stop is requested.

**Files:**
- Modify: `src/webview/ChatViewProvider.ts`

**Step 1: Add handler in resolveWebviewView switch**

In the `resolveWebviewView` message switch (around line 337), add a new case:
```typescript
case 'stopGeneration':
  this.llmAbort?.abort();
  this.consentBroker.rejectAll();
  this.postMessage({ type: 'loading', loading: false });
  logger.info('Chat: generation stopped by user');
  break;
```

**Step 2: Verify it compiles**

Run: `npm run compile`
Expected: clean

**Step 3: Commit**

```bash
git add src/webview/ChatViewProvider.ts
git commit -m "feat: handle stopGeneration — abort stream and dismiss consent"
```

---

### Task 8.3: Add onStop prop to InputBar

**Objective:** Add a callback prop and stop button that appears during streaming.

**Files:**
- Modify: `src/webview-ui/src/components/InputBar.tsx`

**Step 1: Add onStop to Props interface**

Find the Props interface (around line 40) and add:
```typescript
onStop: () => void;
```

**Step 2: Conditionally render stop button**

Find the send button section (lines 572–596). Replace the single send button with a conditional:

```tsx
{isLoading ? (
  <Button
    onClick={onStop}
    variant="icon"
    title="Stop generation"
    className="input-bar__stop-btn"
  >
    <span className="codicon codicon-debug-stop" />
  </Button>
) : (
  <Button
    onClick={handleSend}
    disabled={!canSend}
    variant="icon"
    title="Send message (Enter)"
    className={`input-bar__send-btn ${canSend ? 'input-bar__send-btn--active' : ''}`}
  >
    <span className="codicon codicon-send" />
  </Button>
)}
```

**Step 3: Add stop button CSS**

Add to the component styles or a CSS file:
```css
.input-bar__stop-btn {
  background: var(--vscode-errorForeground);
  color: var(--vscode-button-foreground);
  border-radius: 50%;
}
.input-bar__stop-btn:hover {
  opacity: 0.8;
}
```

**Step 4: Verify it compiles**

Run: `npm run build:webview`
Expected: clean

**Step 5: Commit**

```bash
git add src/webview-ui/src/components/InputBar.tsx
git commit -m "feat: add stop button that appears during LLM streaming"
```

---

### Task 8.4: Wire onStop in App.tsx

**Objective:** Connect the stop button to the postMessage bridge.

**Files:**
- Modify: `src/webview-ui/src/App.tsx`

**Step 1: Add onStop handler**

Find where `<InputBar>` is rendered (around line 443) and add the prop:
```tsx
onStop={() => {
  vscode.postMessage({ type: 'stopGeneration' });
  setLoading(false);
}}
```

**Step 2: Verify it compiles**

Run: `npm run build:webview`
Expected: clean

**Step 3: Commit**

```bash
git add src/webview-ui/src/App.tsx
git commit -m "feat: wire stop button to postMessage bridge"
```

---

### Task 8.5: Test the stop button end-to-end

**Objective:** Verify the stop button works during streaming.

**Step 1: Run all tests**

Run: `npm test`
Expected: all pass

**Step 2: Manual test**

- Send a message that triggers a long response
- While streaming, click the stop button (■)
- Verify: response stops, input bar returns to send mode
- Verify: output channel shows "Chat: generation stopped by user"

---

## Batch 9: Cleanup

### Task 9.1: Wire extended modes or remove dead code

**Objective:** The modes.ts file defines code/architect/ask/debug but only inline/plan/act are wired. Either wire the extended modes or remove them.

**Files:**
- Modify: `src/llm/modes.ts`
- Modify: `package.json` (update mode enum if wiring)

**Step 1: Decision — wire or remove?**

Recommended: **Remove the extended modes for now.** They add complexity without value. The 3-mode system (inline/plan/act) is clear and working. The extended modes can be re-added later if needed.

Remove from `modes.ts`:
- `DEFAULT_MODES` array with 4 entries
- Replace with the 3 wired modes (inline, plan, act) that match `package.json` enum

**Step 2: Update modes.ts to match wired modes**

```typescript
export const DEFAULT_MODES: ModeConfig[] = [
  { slug: 'inline', name: 'Inline', role: 'code', toolGroups: ['read', 'write', 'execute'] },
  { slug: 'plan', name: 'Plan', role: 'architect', toolGroups: ['read'] },
  { slug: 'act', name: 'Act', role: 'full-auto', toolGroups: ['read', 'write', 'execute'] },
];
```

**Step 3: Verify it compiles**

Run: `npm run compile`
Expected: clean

**Step 4: Commit**

```bash
git add src/llm/modes.ts
git commit -m "refactor: remove unused extended modes, align with wired modes"
```

---

### Task 9.2: Final verification

**Objective:** Ensure everything compiles, tests pass, and the extension packages.

**Step 1: Full build**

Run: `npm run build:all`
Expected: clean

**Step 2: Run tests**

Run: `npm test`
Expected: all pass

**Step 3: Package VSIX**

Run: `npx vsce package --allow-missing-repository`
Expected: .vsix file created

**Step 4: Final commit if any fixes needed**

---

## Summary

| Batch | What | Files Changed | Commands Added |
|-------|------|---------------|----------------|
| 1 | Output Channel + Logger | logger.ts, extension.ts, services.ts, McpManager, memory, checkpoints, ChatViewProvider | — |
| 2 | Status Panel | StatusPanelProvider.ts, package.json, extension.ts | adoCode.refreshStatus |
| 3 | Memory Browser | package.json, extension.ts | showMemory, editMemory, clearMemory, showWorkspaceMemory |
| 4 | Token Usage | extension.ts, ChatViewProvider.ts | adoCode.showTokenUsage |
| 5 | Set Mode | package.json, extension.ts | adoCode.setMode |
| 6 | Checkpoint Browser | package.json, extension.ts | adoCode.listCheckpoints |
| 7 | Fix Slash Cmd Bug | InputBar.tsx | — |
| 8 | Stop Button | messages.ts, ChatViewProvider.ts, InputBar.tsx, App.tsx | — |
| 9 | Cleanup | modes.ts | — |

**Total new files:** 2 (logger.ts, StatusPanelProvider.ts)
**Total modified files:** ~12
**Total new commands:** 7
**Total new tree views:** 1 (adoCode.status)
**Bug fixes:** 1 (slash command autocomplete)
**New features:** 1 (stop button)
