# Agent Reference Files, Cross-Platform Tooling & Memory System

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Create universal reference files that coding agents read automatically to understand the project. Add persistent user memory (preferences, custom instructions) and workspace memory (project conventions, architecture decisions) that the LLM reads on every conversation. Include cross-platform Node.js scripts and pre-commit quality gates.

**Architecture:** Seven deliverables: (1) `AGENTS.md` — primary agent reference, (2) `scripts/update-structure.js` — cross-platform structure analysis, (3) `scripts/pre-commit.js` — quality gate script, (4) `docs/playbooks/` — step-by-step recipes, (5) `.hermes/STRUCTURE.md` — generated module map, (6) User Memory system — persistent per-user preferences in VS Code globalState, (7) Workspace Memory system — persistent per-project conventions in `.ado-code/memory/`.

**Tech Stack:** TypeScript (memory system), Node.js (scripts), Markdown (docs/playbooks), husky + lint-staged (pre-commit hooks).

---

## Current Context

- Project: ADO Code v0.3.0 — VS Code extension, AI coding assistant with Azure DevOps integration
- ~80 TypeScript/TSX source files, 83 tests passing, tsc clean
- Node.js 18+ required (already in project requirements)
- Zero runtime dependencies — all tooling uses devDependencies
- No AGENTS.md, no pre-commit hooks, no cross-platform scripts yet

---

## Task 1: Create AGENTS.md

**Objective:** Write the primary agent-facing codebase reference file.

**Files:**
- Create: `AGENTS.md`

**What:** This is the single most important file for coding agents. Claude Code, Codex, Cursor, and others auto-read it. Must be concise (under 400 lines) but comprehensive enough that an agent can make correct decisions without exploring the repo.

**Content:** (see the full content in the plan — covers: What This Is, Build & Test, Project Structure, Architecture by module, Key Patterns for tools/messages/services/testing, Conventions, What NOT to Do)

**Step 1:** Write AGENTS.md with all sections
**Step 2:** Verify it's under 400 lines
**Step 3:** Commit: `git add AGENTS.md && git commit -m "docs: add AGENTS.md for coding agent reference"`

---

## Task 2: Create scripts/update-structure.js

**Objective:** Cross-platform Node.js script that regenerates .hermes/STRUCTURE.md.

**Files:**
- Create: `scripts/update-structure.js`

**Why Node.js instead of bash:** Bash doesn't run natively on Windows. Node.js is already a project dependency and runs identically on Windows, Linux, and macOS.

**Implementation:**

```javascript
#!/usr/bin/env node
/**
 * Regenerate .hermes/STRUCTURE.md from the live source tree.
 * Usage: node scripts/update-structure.js
 *
 * Cross-platform: uses only Node.js built-ins (fs, path).
 */

const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..', 'src');
const OUT = path.resolve(__dirname, '..', '.hermes', 'STRUCTURE.md');

// One-line purpose per file (extend as needed)
const PURPOSES = {
  'src/extension.ts': 'Entry point: activate() registers providers and commands',
  'src/services.ts': 'Composition root: createServices() builds all service instances',
  'src/ado/client.ts': 'ADO REST API client (WIQL, work items, comments, projects)',
  'src/ado/types.ts': 'ADO type definitions (AdoWorkItem, AdoComment, etc.)',
  'src/ado/WorkItemsTreeProvider.ts': 'Tree view data provider for work items',
  'src/ado/WorkItemStatesCache.ts': 'Cached work item type states per project',
  'src/agents/registry.ts': 'AgentRegistry: detects installed external agent CLIs',
  'src/agents/AgentRunner.ts': 'Background agent execution with session resume',
  'src/agents/types.ts': 'Agent types (AgentRun, AgentCapability, AdapterInterface)',
  'src/agents/adapters/index.ts': 'Adapter barrel export',
  'src/agents/adapters/types.ts': 'Adapter interface definition',
  'src/agents/adapters/ClaudeAdapter.ts': 'Claude Code CLI adapter',
  'src/agents/adapters/CodexAdapter.ts': 'OpenAI Codex CLI adapter',
  'src/agents/adapters/OpenCodeAdapter.ts': 'OpenCode CLI adapter',
  'src/agents/adapters/HermesAdapter.ts': 'Hermes Agent CLI adapter',
  'src/agents/adapters/PiAdapter.ts': 'Pi AI CLI adapter',
  'src/agents/adapters/GenericAdapter.ts': 'Generic adapter for aider/openclaw',
  'src/agents/adapters/GeminiAdapter.ts': 'Google Gemini CLI adapter',
  'src/changelog/ChangelogService.ts': 'CHANGELOG.md auto-update on task completion',
  'src/config/settings.ts': 'VS Code settings reader and org selector',
  'src/config/ContextProxy.ts': 'Cached VS Code globalState/secrets access',
  'src/git/GitService.ts': 'Git operations: branch, diff, commit',
  'src/llm/client.ts': 'LlmClient: streaming chat and tool calling',
  'src/llm/agentic.ts': 'runAgenticChat(): multi-iteration tool loop',
  'src/llm/tools.ts': 'ToolExecutor: mode-gated tool dispatch',
  'src/llm/types.ts': 'LLM types (LlmMessage, LlmTool, ToolCall, etc.)',
  'src/llm/modes.ts': 'Mode configs (code, architect, ask, debug)',
  'src/llm/consent.ts': 'Tool approval flow for inline mode',
  'src/llm/tool-approval-ui.ts': 'Consent card UI rendering',
  'src/llm/handler.ts': 'ApiHandler interface and buildApiHandler factory',
  'src/llm/prompts.ts': 'Prompt helpers',
  'src/llm/prompts/system.ts': 'Dynamic system prompt generator',
  'src/llm/providers/BaseProvider.ts': 'Abstract LLM provider base class',
  'src/llm/providers/openai.ts': 'OpenAI provider (legacy)',
  'src/llm/providers/openai-v2.ts': 'OpenAI provider v2 with streaming',
  'src/llm/providers/anthropic.ts': 'Anthropic provider (legacy)',
  'src/llm/providers/anthropic-v2.ts': 'Anthropic provider v2 with streaming',
  'src/llm/tools/BaseTool.ts': 'Abstract tool base class',
  'src/llm/tools/ToolRegistry.ts': 'Singleton tool registry',
  'src/llm/tools/types.ts': 'Tool types and TOOL_GROUP_MAP',
  'src/llm/tools/definitions/index.ts': 'Tool definitions barrel export',
  'src/llm/tools/definitions/types.ts': 'ToolDefinition JSON Schema types',
  'src/llm/tools/definitions/read_file.ts': 'Read file tool definition',
  'src/llm/tools/definitions/edit_file.ts': 'Edit file tool definition',
  'src/llm/tools/definitions/write_to_file.ts': 'Write file tool definition',
  'src/llm/tools/definitions/search_files.ts': 'Search files tool definition',
  'src/llm/tools/definitions/list_files.ts': 'List files tool definition',
  'src/llm/tools/definitions/execute_command.ts': 'Execute command tool definition',
  'src/llm/context/tokenCounter.ts': 'Token counting for context management',
  'src/llm/context/contextManager.ts': 'Context window management',
  'src/llm/context/condenser.ts': 'Long conversation summarization',
  'src/services/checkpoints/types.ts': 'Checkpoint types (manifest, diff)',
  'src/services/checkpoints/CheckpointService.ts': 'File checkpoint save/restore',
  'src/services/mcp/types.ts': 'MCP types (server config, tool info)',
  'src/services/mcp/McpClient.ts': 'MCP client (JSON-RPC over stdio)',
  'src/services/mcp/McpManager.ts': 'Multi-server MCP manager',
  'src/shared/messages.ts': 'Typed message protocol (webview <-> extension)',
  'src/webview/ChatViewProvider.ts': 'WebViewViewProvider: message routing, commands',
  'src/webview-ui/src/App.tsx': 'React app root',
  'src/webview-ui/src/types.ts': 'Webview type definitions',
  'src/webview-ui/src/components/MessageList.tsx': 'Chat message list',
  'src/webview-ui/src/components/InputBar.tsx': 'Chat input with @file mentions',
  'src/webview-ui/src/components/MarkdownRenderer.tsx': 'Markdown rendering',
  'src/webview-ui/src/components/TaskDetailPanel.tsx': 'Task detail view',
  'src/webview-ui/src/components/WelcomeScreen.tsx': 'Unconfigured state',
  'src/webview-ui/src/components/ConsentCard.tsx': 'Tool approval UI',
  'src/webview-ui/src/components/LoadingSpinner.tsx': 'Loading indicator',
  'src/webview-ui/src/components/ProjectSwitcher.tsx': 'Project selection',
  'src/webview-ui/src/components/KebabMenu.tsx': 'Overflow menu',
  'src/webview-ui/src/components/ui/index.ts': 'UI component barrel export',
  'src/webview-ui/src/components/ui/Button.tsx': 'Button component',
  'src/webview-ui/src/components/ui/Tooltip.tsx': 'Tooltip component',
  'src/webview-ui/src/components/ui/Dialog.tsx': 'Modal dialog',
  'src/webview-ui/src/components/ui/ToggleSwitch.tsx': 'Toggle switch',
  'src/webview-ui/src/components/ui/Badge.tsx': 'Status badge',
  'src/webview-ui/src/components/ui/Card.tsx': 'Content card',
  'src/webview-ui/src/components/ui/cn.ts': 'ClassName utility',
};

function walkDir(dir, pattern) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      results.push(...walkDir(full, pattern));
    } else if (pattern.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

function main() {
  // Ensure output directory exists
  const outDir = path.dirname(OUT);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const files = walkDir(SRC, /\.(ts|tsx)$/).sort();
  const lines = files.map(f => fs.readFileSync(f, 'utf8').split('\n').length);
  const totalFiles = files.length;
  const totalLines = lines.reduce((a, b) => a + b, 0);

  // Directory summary
  const dirStats = {};
  for (let i = 0; i < files.length; i++) {
    const rel = path.relative(SRC, files[i]).split(path.sep).slice(0, -1).join('/');
    const dir = rel || '.';
    if (!dirStats[dir]) dirStats[dir] = { files: 0, lines: 0 };
    dirStats[dir].files++;
    dirStats[dir].lines += lines[i];
  }

  let out = '# Codebase Structure (auto-generated)\n\n';
  out += '> Regenerated by `node scripts/update-structure.js`. Do not edit manually.\n\n';
  out += '## Summary\n\n';
  out += '| Directory | Files | Lines |\n';
  out += '|-----------|-------|-------|\n';
  for (const [dir, stats] of Object.entries(dirStats).sort()) {
    out += `| \`${dir}\` | ${stats.files} | ${stats.lines} |\n`;
  }
  out += `| **Total** | **${totalFiles}** | **${totalLines}** |\n`;

  out += '\n## Files\n\n';
  out += '| File | Lines | Purpose |\n';
  out += '|------|-------|---------|\n';
  for (let i = 0; i < files.length; i++) {
    const rel = path.relative(path.resolve(__dirname, '..'), files[i]).replace(/\\/g, '/');
    const purpose = PURPOSES[rel] || '...';
    out += `| \`${rel}\` | ${lines[i]} | ${purpose} |\n`;
  }

  out += `\n_Last regenerated: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC_\n`;

  fs.writeFileSync(OUT, out);
  console.log(`Updated ${path.relative(process.cwd(), OUT)} (${totalFiles} files, ${totalLines} lines)`);
}

main();
```

**Step 1:** Create scripts/update-structure.js
**Step 2:** Run: `node scripts/update-structure.js`
**Step 3:** Verify .hermes/STRUCTURE.md was generated correctly
**Step 4:** Commit: `git add scripts/ .hermes/STRUCTURE.md && git commit -m "docs: add cross-platform structure analysis script"`

---

## Task 3: Create scripts/pre-commit.js

**Objective:** Cross-platform pre-commit quality gate script.

**Files:**
- Create: `scripts/pre-commit.js`

**What:** Runs `npm run compile` and `npm test` before allowing commits. Can be wired as a git pre-commit hook or run via lint-staged.

**Implementation:**

```javascript
#!/usr/bin/env node
/**
 * Pre-commit quality gate. Runs compile + test.
 * Usage: node scripts/pre-commit.js
 *
 * Cross-platform: uses child_process.execSync.
 * Exit code 0 = pass, non-zero = block commit.
 */

const { execSync } = require('child_process');

function run(cmd) {
  console.log(`\n> ${cmd}`);
  try {
    execSync(cmd, { stdio: 'inherit', cwd: __dirname + '/..' });
    return true;
  } catch {
    return false;
  }
}

console.log('=== ADO Code pre-commit checks ===');

const compile = run('npm run compile');
const test = run('npm test');

if (!compile || !test) {
  console.error('\n❌ Pre-commit checks failed. Fix errors before committing.');
  process.exit(1);
}

console.log('\n✅ All pre-commit checks passed.');
```

**Step 1:** Create scripts/pre-commit.js
**Step 2:** Verify it runs: `node scripts/pre-commit.js` (should pass if tests pass)
**Step 3:** Commit: `git add scripts/pre-commit.js && git commit -m "chore: add cross-platform pre-commit script"`

---

## Task 4: Create docs/playbooks/ — Common Tasks Playbooks

**Objective:** Step-by-step recipes for the most common coding tasks.

**Files:**
- Create: `docs/playbooks/add-tool.md`
- Create: `docs/playbooks/add-agent-adapter.md`
- Create: `docs/playbooks/add-message-type.md`
- Create: `docs/playbooks/add-mcp-server.md`

**What:** Agents follow recipes better than general architecture docs. Each playbook is a checklist: exact files to touch, exact code to add, verification steps.

### 4a: Add a New Tool

**File:** `docs/playbooks/add-tool.md`

```markdown
# How to Add a New Tool

## Checklist

1. **Define the tool** — Create `src/llm/tools/definitions/<tool_name>.ts`
   ```typescript
   import { ToolDefinition } from './types';

   export const <toolName>Definition: ToolDefinition = {
     type: 'function',
     function: {
       name: '<tool_name>',
       description: 'What this tool does',
       parameters: {
         type: 'object',
         properties: {
           param1: { type: 'string', description: 'Description' },
         },
         required: ['param1'],
         additionalProperties: false,
       },
     },
   };
   ```

2. **Register the definition** — Add to `src/llm/tools/definitions/index.ts`:
   ```typescript
   import { <toolName>Definition } from './<tool_name>';
   // Add to getNativeTools() array
   ```

3. **Add to ToolExecutor** — In `src/llm/tools.ts`:
   - Add tool to the `tools` array in `createToolExecutor()`
   - Add `case '<tool_name>':` in the `execute()` switch
   - If mutating: add to `MUTATING_TOOLS` set
   - If read-only: add to `READ_ONLY_TOOLS` set

4. **Write test** — Create `src/test/suite/llm/<tool_name>.test.ts`:
   ```typescript
   import * as assert from 'assert';
   import { createToolExecutor } from '../../../llm/tools';

   suite('<ToolName>', () => {
     test('returns expected result', async () => {
       // ... test implementation
     });
   });
   ```

5. **Verify**
   ```bash
   node scripts/pre-commit.js
   ```

6. **Commit**
   ```bash
   git add -A && git commit -m "feat: add <tool_name> tool"
   ```
```

### 4b: Add a New Agent Adapter

**File:** `docs/playbooks/add-agent-adapter.md`

```markdown
# How to Add a New Agent Adapter

## Checklist

1. **Create adapter** — `src/agents/adapters/<Name>Adapter.ts`
   - Implement `AgentAdapter` interface from `./types`
   - `buildArgs(prompt, sessionId?)` → string[]
   - `parseSessionId(output)` → string | null
   - `parseResult(output)` → string

2. **Register in registry** — Add to `src/agents/adapters/index.ts`

3. **Add to AgentRegistry** — In `src/agents/registry.ts`:
   - Add to `AGENT_SPECS` array with detection command

4. **Add VS Code config** — In `package.json`:
   - Add to `adoCode.agents.enabled` enum
   - Add to `adoCode.agents.autoSelect` enum

5. **Write test** — `src/test/suite/agents/adapters.test.ts`

6. **Verify and commit**
```

### 4c: Add a New Message Type

**File:** `docs/playbooks/add-message-type.md`

```markdown
# How to Add a New Message Type

## Checklist

1. **Define in shared protocol** — `src/shared/messages.ts`
   - Add to `WebviewToExtensionMessage` union (if webview → extension)
   - Or add to `ExtensionToWebviewMessage` union (if extension → webview)

2. **Handle in ChatViewProvider** — `src/webview/ChatViewProvider.ts`
   - Add case in `onDidReceiveMessage` switch (for incoming)
   - Or call `postMessage()` (for outgoing)

3. **Handle in webview** — `src/webview-ui/src/App.tsx`
   - Add case in message handler (for incoming)
   - Or call `vscode.postMessage()` (for outgoing)

4. **Verify message types compile** — `npm run compile`

5. **Commit**
```

### 4d: Add an MCP Server

**File:** `docs/playbooks/add-mcp-server.md`

```markdown
# How to Add an MCP Server

## Via Settings (no code changes)

Add to VS Code settings:
```json
{
  "adoCode.mcp.servers": [
    {
      "name": "my-server",
      "command": "npx",
      "args": ["-y", "@myorg/mcp-server"],
      "timeout": 30000
    }
  ]
}
```

Tools appear as `mcp__my-server__<tool-name>` in the agentic loop.

## Via Code (built-in server)

1. Add config to `AGENT_SPECS` or create new adapter
2. Register in McpManager
```

**Step 1:** Create all 4 playbook files
**Step 2:** Commit: `git add docs/playbooks/ && git commit -m "docs: add common task playbooks for agents"`

---

## Task 5: Create .hermes/STRUCTURE.md

**Objective:** Generate the initial structure document.

**Step 1:** Run: `node scripts/update-structure.js`
**Step 2:** Verify output looks correct
**Step 3:** Commit: `git add .hermes/STRUCTURE.md && git commit -m "docs: generate initial STRUCTURE.md"`

---

## Task 6: Install and configure lint-staged + husky

**Objective:** Auto-run compile + test before every commit.

**Files:**
- Modify: `package.json` (add husky + lint-staged config)
- Create: `.husky/pre-commit`

**What:** lint-staged runs checks on staged files. husky runs the git hook. Together they prevent agents (and humans) from committing broken code.

**Step 1:** Install devDependencies:
```bash
npm install --save-dev husky lint-staged
```

**Step 2:** Add to package.json scripts:
```json
"prepare": "husky"
```

**Step 3:** Add to package.json:
```json
"lint-staged": {
  "*.ts": ["node scripts/pre-commit.js"]
}
```

**Step 4:** Create `.husky/pre-commit`:
```bash
npx lint-staged
```

**Step 5:** Initialize husky:
```bash
npx husky
```

**Step 6:** Verify: make a test commit, confirm hooks run
**Step 7:** Commit: `git add -A && git commit -m "chore: add husky + lint-staged pre-commit hooks"`

---

## Task 7: UI — Refresh Icon + Direct Mode Selection

**Objective:** Replace the cycling mode toggle with direct-click mode selection. Add a dedicated refresh icon to the chat header.

**Files:**
- Modify: `src/webview-ui/src/components/InputBar.tsx` — mode toggle click behavior
- Modify: `src/webview-ui/src/styles/app.css` — mode toggle + refresh icon styles
- Modify: `src/webview-ui/src/App.tsx` — add refresh icon to header, new mode handler
- Modify: `src/webview-ui/src/types.ts` — add selectMode message type
- Modify: `src/webview/ChatViewProvider.ts` — handle selectMode message

### 7a: Direct Mode Selection

**Current behavior:** Clicking anywhere on the Chat|Plan|Act bar calls `cycleMode` which cycles inline→plan→act→inline.

**New behavior:** Clicking "Chat" directly selects inline mode. Clicking "Plan" selects plan mode. Clicking "Act" selects act mode.

**Changes in InputBar.tsx:**
```tsx
// Change the mode-toggle onClick from onModeChange to individual handlers
// Each mode-option gets its own onClick that sets that specific mode

// Replace:
<span className="mode-toggle" onClick={onModeChange} title="Click to change mode">
  <span className={`mode-option ${mode === 'inline' ? 'mode-active' : ''}`}>Chat</span>
  <span className={`mode-option ${mode === 'plan' ? 'mode-active' : ''}`}>Plan</span>
  <span className={`mode-option ${mode === 'act' ? 'mode-active' : ''}`}>Act</span>
</span>

// With:
<span className="mode-toggle">
  <span
    className={`mode-option ${mode === 'inline' ? 'mode-active' : ''}`}
    onClick={() => onModeSelect('inline')}
    title="Chat mode: streaming with inline tool calls"
  >Chat</span>
  <span
    className={`mode-option ${mode === 'plan' ? 'mode-active' : ''}`}
    onClick={() => onModeSelect('plan')}
    title="Plan mode: read-only, produces implementation plan"
  >Plan</span>
  <span
    className={`mode-option ${mode === 'act' ? 'mode-active' : ''}`}
    onClick={() => onModeSelect('act')}
    title="Act mode: autonomous agentic loop with auto-approval"
  >Act</span>
</span>
```

**Update Props interface in InputBar.tsx:**
```tsx
// Replace:
onModeChange: () => void;

// With:
onModeSelect: (mode: 'inline' | 'plan' | 'act') => void;
```

**Changes in App.tsx:**
```tsx
// Replace handleModeChange with handleModeSelect:
const handleModeSelect = useCallback((newMode: 'inline' | 'plan' | 'act') => {
  vscode.postMessage({ type: 'selectMode', mode: newMode });
}, []);

// Update InputBar usage:
<InputBar
  onModeSelect={handleModeSelect}
  // ... rest
/>
```

**Add to types.ts (WebviewToExtensionMessage):**
```typescript
| { type: 'selectMode'; mode: 'inline' | 'plan' | 'act' }
```

**Handle in ChatViewProvider.ts:**
```typescript
case 'selectMode': {
  // Persist the mode choice
  const config = vscode.workspace.getConfiguration('adoCode');
  await config.update('mode', msg.mode, vscode.ConfigurationTarget.Global);
  // Notify webview
  this._view?.webview.postMessage({ type: 'modeChanged', mode: msg.mode });
  break;
}
```

**CSS cleanup in app.css:**
```css
/* Mode toggle — individual clickable pills */
.mode-toggle {
  display: flex;
  align-items: center;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
  border-radius: 12px;
  overflow: hidden;
  user-select: none;
}

.mode-option {
  padding: 2px 10px;
  font-size: 0.7em;
  font-weight: 500;
  color: var(--vscode-input-foreground);
  background: transparent;
  transition: background 0.15s, color 0.15s;
  cursor: pointer;
}

/* Hover effect for non-active modes */
.mode-option:not(.mode-active):hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

.mode-active {
  background: var(--vscode-focusBorder);
  color: #fff;
  cursor: default; /* Already selected — no action */
}
```

### 7b: Refresh Icon in Chat Header

**Add a refresh icon** next to the ADO Code title in the chat header. This provides quick access to refresh work items without going to the sidebar.

**Changes in App.tsx — chat header:**
```tsx
{/* Chat header with project switcher + kebab menu */}
<div className="chat-header">
  <span className="chat-header-title">ADO Code</span>
  <button
    className="header-refresh-btn"
    onClick={() => vscode.postMessage({ type: 'fetchWorkItems' })}
    title="Refresh Work Items"
    aria-label="Refresh Work Items"
  >
    ↻
  </button>
  <ProjectSwitcher
    projects={projects}
    current={config.adoProject}
    loading={projectsLoading}
    onSwitch={handleSwitchProject}
    onRefresh={handleFetchProjects}
  />
  <KebabMenu
    items={[
      { label: 'Rerun Setup Wizard', icon: '🔄', action: 'rerunWizard' },
      { label: 'Configuration…', icon: '⚙', action: 'openSettings' },
    ]}
    onSelect={handleKebabAction}
  />
</div>
```

**CSS for refresh button:**
```css
.header-refresh-btn {
  background: none;
  border: 1px solid var(--vscode-input-border);
  border-radius: 3px;
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
  padding: 0 6px;
  cursor: pointer;
  flex-shrink: 0;
}

.header-refresh-btn:hover {
  color: var(--vscode-textLink-foreground);
  border-color: var(--vscode-textLink-foreground);
}
```

### Step-by-step:

**Step 1:** Update InputBar.tsx — change onModeChange to onModeSelect with per-mode onClick
**Step 2:** Update App.tsx — add handleModeSelect, add refresh icon to header
**Step 3:** Update types.ts — add selectMode message type
**Step 4:** Update ChatViewProvider.ts — handle selectMode message
**Step 5:** Update app.css — mode-option cursor/hover, header-refresh-btn styles
**Step 6:** Run: `npm run compile && npm run build:webview`
**Step 7:** Commit: `git add -A && git commit -m "feat: direct mode selection + header refresh icon"`

---

## Task 8: UI — Slash Commands with Autocomplete

**Objective:** Expand the existing `/status` and `/comment` slash commands into a full command system with autocomplete dropdown in the InputBar.

**Files:**
- Modify: `src/webview/ChatViewProvider.ts` — expand slash command parsing
- Modify: `src/webview-ui/src/components/InputBar.tsx` — add slash command autocomplete
- Modify: `src/webview-ui/src/styles/app.css` — slash command dropdown styles
- Modify: `src/webview-ui/src/types.ts` — add slash command types
- Create: `src/shared/slashCommands.ts` — command registry

**What:** When the user types `/` in the input, show an autocomplete dropdown of available commands. Each command has a name, description, and optional arguments. Commands execute immediately or prompt for arguments.

### Command Registry

Create `src/shared/slashCommands.ts`:
```typescript
export interface SlashCommand {
  name: string;
  description: string;
  args?: Array<{
    name: string;
    description: string;
    required: boolean;
    prompt?: string; // If set, show input box to collect this arg
  }>;
  /** If true, execute immediately without sending to LLM */
  immediate: boolean;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  // ── ADO commands ─────────────────────────────────────────────
  {
    name: '/status',
    description: 'Change work item state (e.g. /status Active)',
    args: [{ name: 'state', description: 'New state', required: true, prompt: 'Set state to…' }],
    immediate: true,
  },
  {
    name: '/comment',
    description: 'Add a comment to the active work item',
    args: [{ name: 'text', description: 'Comment text', required: true }],
    immediate: true,
  },
  {
    name: '/pick',
    description: 'Select a work item from the list',
    immediate: true,
  },
  {
    name: '/assign',
    description: 'Reassign the active work item',
    args: [{ name: 'who', description: 'Assignee (email or name)', required: true }],
    immediate: true,
  },

  // ── Chat commands ────────────────────────────────────────────
  {
    name: '/clear',
    description: 'Clear chat history',
    immediate: true,
  },
  {
    name: '/mode',
    description: 'Switch mode (chat, plan, act)',
    args: [{ name: 'mode', description: 'inline, plan, or act', required: true }],
    immediate: true,
  },
  {
    name: '/undo',
    description: 'Restore files to the last checkpoint',
    immediate: true,
  },
  {
    name: '/help',
    description: 'Show available commands',
    immediate: true,
  },

  // ── Agent commands ───────────────────────────────────────────
  {
    name: '/delegate',
    description: 'Delegate to an external agent (claude, codex, etc.)',
    args: [
      { name: 'agent', description: 'Agent name (optional — auto-pick if omitted)', required: false },
    ],
    immediate: true,
  },
  {
    name: '/resume',
    description: 'Resume an interrupted agent session',
    immediate: true,
  },

  // ── Memory commands ──────────────────────────────────────────
  {
    name: '/remember',
    description: 'Remember a preference or instruction',
    args: [
      { name: 'what', description: 'What to remember', required: true },
    ],
    immediate: true,
  },
  {
    name: '/forget',
    description: 'Remove a memory entry',
    args: [{ name: 'key', description: 'Memory key to remove', required: true }],
    immediate: true,
  },
];

/** Find commands matching a prefix (e.g. "/sta" → ["/status"]) */
export function matchCommands(input: string): SlashCommand[] {
  if (!input.startsWith('/')) return [];
  const lower = input.toLowerCase();
  return SLASH_COMMANDS.filter(cmd => cmd.name.startsWith(lower));
}

/** Parse a slash command string into name + args */
export function parseSlashCommand(input: string): { command: SlashCommand; args: Record<string, string> } | null {
  const match = input.match(/^\/(\w+)\s*(.*)/);
  if (!match) return null;
  const cmdName = '/' + match[1];
  const cmd = SLASH_COMMANDS.find(c => c.name === cmdName);
  if (!cmd) return null;

  const argsStr = match[2].trim();
  const args: Record<string, string> = {};

  if (cmd.args && cmd.args.length > 0 && argsStr) {
    // Simple parsing: first arg gets the first word, rest goes to last arg
    if (cmd.args.length === 1) {
      args[cmd.args[0].name] = argsStr;
    } else {
      const parts = argsStr.split(/\s+/);
      for (let i = 0; i < cmd.args.length; i++) {
        if (i === cmd.args.length - 1) {
          args[cmd.args[i].name] = parts.slice(i).join(' ');
        } else {
          args[cmd.args[i].name] = parts[i] || '';
        }
      }
    }
  }

  return { command: cmd, args };
}
```

### Slash Command Autocomplete in InputBar

**Add to InputBar.tsx:**
```tsx
// State for slash command autocomplete
const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
const [slashIndex, setSlashIndex] = useState(0);
const [showSlashDropdown, setShowSlashDropdown] = useState(false);

// Detect slash command typing
useEffect(() => {
  if (value.startsWith('/') && !value.includes(' ')) {
    const matches = matchCommands(value);
    setSlashCommands(matches);
    setShowSlashDropdown(matches.length > 0);
    setSlashIndex(0);
  } else {
    setShowSlashDropdown(false);
  }
}, [value]);

// Handle slash command selection
const selectSlashCommand = useCallback((cmd: SlashCommand) => {
  if (cmd.args && cmd.args.length > 0 && cmd.args[0].prompt) {
    // Show VS Code input box for the arg
    acquireVsCodeApi().postMessage({ type: 'slashCommandPrompt', command: cmd.name, arg: cmd.args[0].name, prompt: cmd.args[0].prompt });
  } else {
    // Set the command text
    setValue(cmd.name + ' ');
  }
  setShowSlashDropdown(false);
}, []);

// Keyboard navigation for slash dropdown
// Up/Down arrows navigate, Enter selects, Escape closes
```

**Render the dropdown:**
```tsx
{showSlashDropdown && slashCommands.length > 0 && (
  <div className="slash-dropdown" ref={slashDropdownRef}>
    {slashCommands.map((cmd, i) => (
      <div
        key={cmd.name}
        className={`slash-option ${i === slashIndex ? 'slash-active' : ''}`}
        onClick={() => selectSlashCommand(cmd)}
      >
        <span className="slash-name">{cmd.name}</span>
        <span className="slash-desc">{cmd.description}</span>
      </div>
    ))}
  </div>
)}
```

### Handle in ChatViewProvider.ts

Expand the existing slash command parsing:
```typescript
private async handleUserMessage(content: string): Promise<void> {
  // Parse slash commands
  const parsed = parseSlashCommand(content);
  if (parsed) {
    await this.executeSlashCommand(parsed.command, parsed.args);
    return;
  }
  // ... rest of existing LLM handling
}

private async executeSlashCommand(cmd: SlashCommand, args: Record<string, string>): Promise<void> {
  switch (cmd.name) {
    case '/status':
      if (!this.activeWorkItem) {
        vscode.window.showWarningMessage('ADO Code: select a work item first.');
        return;
      }
      await this.updateWorkItemState(this.activeWorkItem.id, args.state || '');
      break;

    case '/comment':
      if (!this.activeWorkItem) {
        vscode.window.showWarningMessage('ADO Code: select a work item first.');
        return;
      }
      await this.services.ado.addComment(this.activeProject(), this.activeWorkItem.id, args.text || '');
      vscode.window.showInformationMessage(`ADO Code: comment added to ADO-${this.activeWorkItem.id}.`);
      break;

    case '/pick':
      // Trigger work item selection
      this.postMessage({ type: 'promptWorkItemSelection' });
      break;

    case '/assign':
      if (!this.activeWorkItem) {
        vscode.window.showWarningMessage('ADO Code: select a work item first.');
        return;
      }
      await this.services.ado.updateWorkItem(this.activeProject(), this.activeWorkItem.id, [
        { op: 'add', path: '/fields/System.AssignedTo', value: args.who || '' },
      ]);
      vscode.window.showInformationMessage(`ADO Code: assigned to ${args.who}.`);
      break;

    case '/clear':
      this.conversation = [];
      this.postMessage({ type: 'conversationCleared' });
      break;

    case '/mode': {
      const mode = (args.mode || 'inline') as 'inline' | 'plan' | 'act';
      const config = vscode.workspace.getConfiguration('adoCode');
      await config.update('mode', mode, vscode.ConfigurationTarget.Global);
      this.postMessage({ type: 'modeChanged', mode });
      break;
    }

    case '/undo':
      // Restore last checkpoint for active work item
      if (this.activeWorkItem) {
        // Find the most recent auto-checkpoint
        const checkpoints = this.services.checkpoints.listCheckpoints('__auto__');
        if (checkpoints.length > 0) {
          const latest = checkpoints[0];
          const restored = this.services.checkpoints.restore(latest.id, '__auto__');
          vscode.window.showInformationMessage(`ADO Code: restored ${restored.length} file(s) from checkpoint.`);
        } else {
          vscode.window.showWarningMessage('ADO Code: no checkpoints available.');
        }
      }
      break;

    case '/help': {
      const helpText = SLASH_COMMANDS.map(cmd => {
        const argsStr = cmd.args ? ' ' + cmd.args.map(a => a.required ? `<${a.name}>` : `[${a.name}]`).join(' ') : '';
        return `**${cmd.name}${argsStr}** — ${cmd.description}`;
      }).join('\n');
      this.postMessage({ type: 'assistantMessage', content: '## Available Commands\n\n' + helpText, done: true });
      break;
    }

    case '/delegate':
      // Trigger agent delegation
      if (this.activeWorkItem) {
        await this.startTaskWithAgent(this.activeWorkItem.id, args.agent);
      } else {
        vscode.window.showWarningMessage('ADO Code: select a work item first.');
      }
      break;

    case '/resume': {
      const interrupted = this.agentRunner?.listRuns().filter(r => r.status === 'interrupted' && r.sessionId) || [];
      if (interrupted.length === 0) {
        vscode.window.showWarningMessage('ADO Code: no interrupted sessions to resume.');
      } else {
        const pick = await vscode.window.showQuickPick(
          interrupted.map(r => ({ label: `ADO-${r.workItemId} (${r.agent})`, description: r.id })),
          { placeHolder: 'Resume which session?' }
        );
        if (pick) this.agentRunner?.resumeInterrupted(pick.description!, 'Continue where you left off.');
      }
      break;
    }

    case '/remember':
      this.services.memory.set(args.what?.replace(/\s+/g, '-').toLowerCase() || 'custom', 'instruction', args.what || '');
      vscode.window.showInformationMessage(`ADO Code: remembered "${args.what}".`);
      break;

    case '/forget':
      this.services.memory.delete(args.key || '');
      vscode.window.showInformationMessage(`ADO Code: forgot "${args.key}".`);
      break;
  }
}
```

### CSS for Slash Dropdown
```css
.slash-dropdown {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  background: var(--vscode-dropdown-background);
  border: 1px solid var(--vscode-dropdown-border);
  border-radius: 6px;
  max-height: 200px;
  overflow-y: auto;
  z-index: 100;
  box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.15);
}

.slash-option {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
  font-size: 0.85em;
}

.slash-option:hover,
.slash-active {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}

.slash-name {
  font-weight: 600;
  color: var(--vscode-textLink-foreground);
  white-space: nowrap;
}

.slash-desc {
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

### Step-by-step:

**Step 1:** Create `src/shared/slashCommands.ts` with command registry
**Step 2:** Update ChatViewProvider.ts — replace inline parsing with `executeSlashCommand()`
**Step 3:** Update InputBar.tsx — add slash dropdown state, detection, selection, keyboard nav
**Step 4:** Update app.css — slash dropdown styles
**Step 5:** Run: `npm run compile && npm run build:webview`
**Step 6:** Commit: `git add -A && git commit -m "feat: slash commands with autocomplete dropdown"`

---

## Task 9: Create User Memory System

**Objective:** Persistent per-user preferences and custom instructions that the LLM reads on every conversation.

**Files:**
- Create: `src/memory/UserMemory.ts`
- Create: `src/test/suite/memory/userMemory.test.ts`
- Modify: `src/services.ts` (add memory to Services)
- Modify: `src/llm/prompts/system.ts` (inject user memory into system prompt)

**What:** User memory stores preferences that persist across workspaces and sessions. Saved in VS Code globalState (survives extension reloads, workspace changes). The LLM system prompt includes user memory so the AI knows the user's preferences without being told each time.

**Memory categories:**
- `preferences` — UI preferences, default model, default mode
- `instructions` — Custom system instructions the user wants the AI to follow
- `corrections` — Things the user corrected the AI on ("don't use var", "always use conventional commits")
- `context` — Persistent context about the user (role, team, project focus)

**Implementation:**

Create `src/memory/UserMemory.ts`:
```typescript
import * as vscode from 'vscode';

export interface UserMemoryEntry {
  key: string;
  category: 'preference' | 'instruction' | 'correction' | 'context';
  content: string;
  timestamp: number;
}

export class UserMemory {
  private static readonly STATE_KEY = 'adoCode.userMemory';
  private entries: UserMemoryEntry[] = [];

  constructor(private context: vscode.ExtensionContext) {
    this.entries = context.workspaceState.get<UserMemoryEntry[]>(UserMemory.STATE_KEY, []);
    // Also check globalState for cross-workspace memory
    const global = context.globalState.get<UserMemoryEntry[]>(UserMemory.STATE_KEY, []);
    // Merge: global entries not in workspace take effect
    const workspaceKeys = new Set(this.entries.map(e => e.key));
    for (const g of global) {
      if (!workspaceKeys.has(g.key)) this.entries.push(g);
    }
  }

  /** Get all memory entries, optionally filtered by category. */
  getAll(category?: string): UserMemoryEntry[] {
    if (category) return this.entries.filter(e => e.category === category);
    return [...this.entries];
  }

  /** Get a formatted string for injection into the system prompt. */
  toPromptString(): string {
    if (this.entries.length === 0) return '';
    const lines = ['## User Memory', ''];
    const grouped: Record<string, UserMemoryEntry[]> = {};
    for (const e of this.entries) {
      if (!grouped[e.category]) grouped[e.category] = [];
      grouped[e.category].push(e);
    }
    for (const [cat, entries] of Object.entries(grouped)) {
      lines.push(`### ${cat.charAt(0).toUpperCase() + cat.slice(1)}s`);
      for (const e of entries) {
        lines.push(`- ${e.content}`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  /** Add or update a memory entry. If key exists, update content. */
  set(key: string, category: UserMemoryEntry['category'], content: string): void {
    const existing = this.entries.findIndex(e => e.key === key);
    const entry: UserMemoryEntry = { key, category, content, timestamp: Date.now() };
    if (existing >= 0) {
      this.entries[existing] = entry;
    } else {
      this.entries.push(entry);
    }
    this.persist();
  }

  /** Remove a memory entry by key. */
  delete(key: string): void {
    this.entries = this.entries.filter(e => e.key !== key);
    this.persist();
  }

  /** Clear all memory. */
  clear(): void {
    this.entries = [];
    this.persist();
  }

  private persist(): void {
    this.context.workspaceState.update(UserMemory.STATE_KEY, this.entries);
    this.context.globalState.update(UserMemory.STATE_KEY, this.entries);
  }
}
```

**Add to Services (src/services.ts):**
```typescript
import { UserMemory } from './memory/UserMemory';

export interface Services {
  // ... existing services
  memory: UserMemory;
}

// In createServices():
memory: new UserMemory(context),
```

**Inject into system prompt (src/llm/prompts/system.ts):**
Add the user memory content after the base system prompt, before the tool guidelines:
```typescript
const userMemory = services.memory.toPromptString();
if (userMemory) {
  prompt += '\n\n' + userMemory;
}
```

**Add tool for memory management (src/llm/tools.ts):**
Add a `set_memory` tool so the AI can learn and remember:
```typescript
{
  name: 'set_memory',
  description: 'Remember a user preference, instruction, or correction for future conversations',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Short identifier (e.g. "no-var", "commit-style")' },
      category: { type: 'string', enum: ['preference', 'instruction', 'correction', 'context'] },
      content: { type: 'string', description: 'What to remember' },
    },
    required: ['key', 'category', 'content'],
  },
},
```

Handle in execute():
```typescript
case 'set_memory':
  services.memory.set(args.key, args.category, args.content);
  return JSON.stringify({ ok: true, key: args.key });
```

**Tests:**
- Create `src/test/suite/memory/userMemory.test.ts`
- Test: set and get entries
- Test: update existing entry
- Test: delete entry
- Test: toPromptString() formats correctly
- Test: clear() removes all

**Step 1:** Create UserMemory.ts
**Step 2:** Write tests
**Step 3:** Wire into Services and system prompt
**Step 4:** Add set_memory tool
**Step 5:** Run: `npm run compile && npm test`
**Step 6:** Commit: `git add -A && git commit -m "feat: add user memory system with LLM integration"`

---

## Task 10: Create Workspace Memory System

**Objective:** Persistent per-project conventions and architecture decisions stored in `.ado-code/memory/`.

**Files:**
- Create: `src/memory/WorkspaceMemory.ts`
- Create: `src/test/suite/memory/workspaceMemory.test.ts`
- Modify: `src/services.ts` (add workspaceMemory to Services)
- Modify: `src/llm/prompts/system.ts` (inject workspace memory)

**What:** Workspace memory is scoped to a specific project. Stored as markdown files in `.ado-code/memory/` so it can be committed to git (shared with team) or gitignored (personal). The LLM reads workspace memory on every conversation to understand project conventions.

**File structure:**
```
 ado-code/memory/
 ├── conventions.md    # Coding conventions (naming, patterns, style)
 ├── architecture.md   # Architecture decisions and rationale
 ├── gotchas.md        # Known gotchas and pitfalls
 └── custom.md         # User-defined project-specific notes
```

**Implementation:**

Create `src/memory/WorkspaceMemory.ts`:
```typescript
import * as fs from 'fs';
import * as path from 'path';

export class WorkspaceMemory {
  private memoryDir: string;

  constructor(workspaceDir: string) {
    this.memoryDir = path.join(workspaceDir, '.ado-code', 'memory');
  }

  /** Ensure memory directory exists. */
  init(): void {
    if (!fs.existsSync(this.memoryDir)) {
      fs.mkdirSync(this.memoryDir, { recursive: true });
    }
  }

  /** Read a memory file. Returns empty string if not found. */
  read(name: string): string {
    const file = path.join(this.memoryDir, `${name}.md`);
    if (!fs.existsSync(file)) return '';
    return fs.readFileSync(file, 'utf8');
  }

  /** Write a memory file. */
  write(name: string, content: string): void {
    this.init();
    const file = path.join(this.memoryDir, `${name}.md`);
    fs.writeFileSync(file, content, 'utf8');
  }

  /** Delete a memory file. */
  delete(name: string): void {
    const file = path.join(this.memoryDir, `${name}.md`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  /** List all memory files. */
  list(): string[] {
    if (!fs.existsSync(this.memoryDir)) return [];
    return fs.readdirSync(this.memoryDir)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''));
  }

  /** Get a formatted string for injection into the system prompt. */
  toPromptString(): string {
    const files = this.list();
    if (files.length === 0) return '';
    const lines = ['## Workspace Memory', ''];
    for (const name of files) {
      const content = this.read(name);
      if (content.trim()) {
        lines.push(`### ${name}`);
        lines.push(content.trim());
        lines.push('');
      }
    }
    return lines.join('\n');
  }

  /** Get the memory directory path (for .gitignore checks). */
  getDir(): string {
    return this.memoryDir;
  }
}
```

**Add to Services (src/services.ts):**
```typescript
import { WorkspaceMemory } from './memory/WorkspaceMemory';

export interface Services {
  // ... existing services
  workspaceMemory: WorkspaceMemory;
}

// In createServices():
workspaceMemory: new WorkspaceMemory(workspaceRoot),
```

**Inject into system prompt:** Add after user memory:
```typescript
const wsMemory = services.workspaceMemory.toPromptString();
if (wsMemory) {
  prompt += '\n\n' + wsMemory;
}
```

**Add tools for workspace memory (src/llm/tools.ts):**
```typescript
{
  name: 'read_workspace_memory',
  description: 'Read a workspace memory file (conventions, architecture, gotchas, custom)',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Memory file name (without .md extension)' },
    },
    required: ['name'],
  },
},
{
  name: 'write_workspace_memory',
  description: 'Write or update a workspace memory file',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Memory file name (without .md extension)' },
      content: { type: 'string', description: 'Markdown content to write' },
    },
    required: ['name', 'content'],
  },
},
{
  name: 'list_workspace_memory',
  description: 'List all workspace memory files',
  parameters: { type: 'object', properties: {} },
},
```

Handle in execute():
```typescript
case 'read_workspace_memory':
  return services.workspaceMemory.read(args.name) || JSON.stringify({ error: 'not found' });
case 'write_workspace_memory':
  services.workspaceMemory.write(args.name, args.content);
  return JSON.stringify({ ok: true, name: args.name });
case 'list_workspace_memory':
  return JSON.stringify(services.workspaceMemory.list());
```

**Add to .gitignore (optional):** Users can choose to commit or ignore workspace memory:
```
# .ado-code/memory/ — uncomment to ignore workspace memory
# .ado-code/memory/
```

**Tests:**
- Create `src/test/suite/memory/workspaceMemory.test.ts`
- Test: write and read memory files
- Test: list returns all files
- Test: delete removes file
- Test: toPromptString() formats correctly
- Test: read non-existent returns empty string

**Step 1:** Create WorkspaceMemory.ts
**Step 2:** Write tests
**Step 3:** Wire into Services and system prompt
**Step 4:** Add tools
**Step 5:** Run: `npm run compile && npm test`
**Step 6:** Commit: `git add -A && git commit -m "feat: add workspace memory system with LLM tools"`

---

## Task 11: Add memory playbooks

**Objective:** Document how to use the memory system.

**Files:**
- Create: `docs/playbooks/user-memory.md`
- Create: `docs/playbooks/workspace-memory.md`

### User Memory Playbook

**File:** `docs/playbooks/user-memory.md`

```markdown
# User Memory

User memory stores your preferences across all workspaces.

## Storage
- VS Code globalState (persists across sessions and workspaces)
- WorkspaceState (workspace-specific overrides)

## Categories
- **preference** — UI and tool preferences
- **instruction** — Custom instructions for the AI
- **correction** — Things the AI got wrong
- **context** — Background about you/your team

## Management via Chat
Ask the AI:
- "Remember that I prefer conventional commits"
- "Don't use var, only let/const"
- "I'm a senior backend engineer focused on Node.js"

The AI will use the `set_memory` tool to store these.

## Management via VS Code
Open Command Palette → "ADO Code: Show User Memory"
```

### Workspace Memory Playbook

**File:** `docs/playbooks/workspace-memory.md`

```markdown
# Workspace Memory

Workspace memory stores project-specific conventions in `.ado-code/memory/`.

## Files
| File | Purpose |
|------|---------|
| `conventions.md` | Coding style, naming patterns |
| `architecture.md` | Design decisions, rationale |
| `gotchas.md` | Known pitfalls, workarounds |
| `custom.md` | Anything else project-specific |

## Via Chat
Ask the AI:
- "Add to conventions: use zod for validation"
- "Remember this architecture decision: we chose event-driven for..."
- "Add to gotchas: the comments API requires project segment in URL"

## Via Files
Edit `.ado-code/memory/*.md` directly. The AI reads these on every conversation.

## Git Integration
- Commit `.ado-code/memory/` to share conventions with your team
- Or add to .gitignore for personal notes only
```

**Step 1:** Create both playbook files
**Step 2:** Commit: `git add docs/playbooks/ && git commit -m "docs: add memory system playbooks"`

---

## Task 12: Final verification

**Objective:** Verify all deliverables work together.

**Step 1:** `npm run compile` — must be clean
**Step 2:** `npm test` — all tests passing
**Step 3:** `node scripts/update-structure.js` — regenerates STRUCTURE.md
**Step 4:** `node scripts/pre-commit.js` — passes
**Step 5:** Read AGENTS.md — confirm accurate, under 400 lines
**Step 6:** Read docs/playbooks/ — confirm all 6 exist (4 original + 2 memory)
**Step 7:** Test user memory: set_memory tool creates entry
**Step 8:** Test workspace memory: write_workspace_memory creates file in .ado-code/memory/
**Step 9:** Final commit if any fixes needed

---

## Summary of Deliverables

| File | Purpose | Cross-platform |
|------|---------|----------------|
| `AGENTS.md` | Universal agent reference | ✅ (Markdown) |
| `scripts/update-structure.js` | Regenerate STRUCTURE.md | ✅ (Node.js) |
| `scripts/pre-commit.js` | Quality gate (compile + test) | ✅ (Node.js) |
| `docs/playbooks/add-tool.md` | Recipe: add a new tool | ✅ (Markdown) |
| `docs/playbooks/add-agent-adapter.md` | Recipe: add agent adapter | ✅ (Markdown) |
| `docs/playbooks/add-message-type.md` | Recipe: add message type | ✅ (Markdown) |
| `docs/playbooks/add-mcp-server.md` | Recipe: add MCP server | ✅ (Markdown) |
| `docs/playbooks/user-memory.md` | Guide: user memory system | ✅ (Markdown) |
| `docs/playbooks/workspace-memory.md` | Guide: workspace memory | ✅ (Markdown) |
| `src/memory/UserMemory.ts` | Per-user persistent preferences | ✅ (TypeScript) |
| `src/memory/WorkspaceMemory.ts` | Per-project conventions | ✅ (TypeScript) |
| `.hermes/STRUCTURE.md` | Generated module map | ✅ (auto-generated) |
| `.husky/pre-commit` | Git hook | ✅ (husky) |
| `lint-staged` config | Staged file checks | ✅ (Node.js) |

## New Tools Added

| Tool | Scope | Purpose |
|------|-------|---------|
| `set_memory` | User | Store a preference, instruction, or correction |
| `read_workspace_memory` | Workspace | Read a project convention file |
| `write_workspace_memory` | Workspace | Write/update a project convention |
| `list_workspace_memory` | Workspace | List all workspace memory files |
