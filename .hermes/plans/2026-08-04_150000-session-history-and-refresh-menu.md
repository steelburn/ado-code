# Session History & Refresh Menu Move — Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add per-workspace+ADO-project session history with the ability to switch between sessions, create new sessions, and move the refresh-work-items button into the kebab menu.

**Architecture:** Sessions are stored as an array of `{ id, name, createdAt, messages }` objects in `workspaceState`, keyed by `{folderFsPath}:{project}`. The active session ID is tracked separately. A new `SessionHistory` component renders in the chat header replacing the old refresh button, showing a dropdown of past sessions with a "New Session" action. The refresh button moves to the kebab menu. Backward-compatible migration handles the single-conversation format.

**Tech Stack:** TypeScript, React (webview-ui), VS Code workspaceState API, Mocha tests

---

## Current State Summary

- Single conversation stored as `LlmMessage[]` in `workspaceState` under `adoCode.chatHistory:{folderFsPath}`
- On startup, a VS Code QuickPick asks "Continue previous chat session?"
- `/resume` slash command loads the last conversation; `/clear` empties it
- Header has `↻` refresh button (calls `fetchWorkItems`)
- Kebab menu has: "Rerun Setup Wizard", "Configuration..."
- `ProjectSwitcher` has its own `↻` for refreshing the project list (separate concern — stays)

---

## Files Likely to Change

| File | Action | Purpose |
|------|--------|---------|
| `src/shared/messages.ts` | Modify | Add session management message types |
| `src/shared/slashCommands.ts` | Modify | Update `/resume` to list sessions |
| `src/webview/ChatViewProvider.ts` | Modify | Session CRUD, persistence, migration, handle new messages |
| `src/webview-ui/src/App.tsx` | Modify | Session state, pass to header, handle new messages |
| `src/webview-ui/src/components/SessionHistory.tsx` | Create | Session list dropdown + new session button |
| `src/webview-ui/src/components/KebabMenu.tsx` | Modify | Add "Refresh Work Items" item |
| `src/webview-ui/src/styles/app.css` | Modify | Session history styles |
| `src/extension.ts` | Modify | Update startup session restoration |
| `src/test/suite/webview/session.test.ts` | Create | Session persistence tests |
| `src/test/suite/webview/conversation.test.ts` | Modify | Update for new session format |

---

## Data Model

```typescript
interface Session {
  id: string;           // ISO timestamp (Date.now() based)
  name: string;         // Auto-generated from first user message, or "New Session"
  createdAt: string;    // ISO date string
  messages: LlmMessage[];
}
```

**workspaceState keys:**
- `adoCode.sessions:{folderFsPath}:{project}` → `Session[]` (all sessions)
- `adoCode.activeSessionId:{folderFsPath}:{project}` → `string` (active session ID)

**Migration:** On first load, if `adoCode.sessions:*` doesn't exist but `adoCode.chatHistory:{key}` does, wrap the old messages in a single Session and write to the new key. Delete the old key.

---

## Task Breakdown

### Task 1: Add session types to shared messages

**Objective:** Define `Session` interface and new message types for session management.

**Files:**
- Modify: `src/shared/messages.ts`

**Step 1: Add Session interface and message types**

Add after the `ExtensionConfig` interface:

```typescript
// ── Session History (Task 1) ─────────────────────────────────────
export interface Session {
  id: string;           // ISO timestamp used as unique ID
  name: string;         // Display name (auto from first message, or user-set)
  createdAt: string;    // ISO date string
  messages: Array<{ role: string; content: string }>;
}
```

Add to `WebviewToExtensionMessage`:

```typescript
  // Session history
  | { type: 'listSessions' }
  | { type: 'switchSession'; sessionId: string }
  | { type: 'newSession' }
  | { type: 'renameSession'; sessionId: string; name: string }
  | { type: 'deleteSession'; sessionId: string }
```

Add to `ExtensionToWebviewMessage`:

```typescript
  // Session history
  | { type: 'sessionList'; sessions: Session[]; activeId: string | null }
  | { type: 'sessionSwitched'; session: Session }
```

**Step 2: Verify compilation**

Run: `npm run compile`
Expected: clean (no errors)

**Step 3: Commit**

```bash
git add src/shared/messages.ts
git commit -m "feat: add session history types to shared messages"
```

---

### Task 2: Session persistence in ChatViewProvider

**Objective:** Implement session CRUD operations and backward-compatible migration in the extension host.

**Files:**
- Modify: `src/webview/ChatViewProvider.ts`

**Step 1: Add session storage helpers**

Add private methods to `ChatViewProvider` after the existing `persistConversation()` / `restoreConversation()` / `trimConversation()` methods (around line 730):

```typescript
  // ── Session History ──────────────────────────────────────────────
  private get sessionKey(): string {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'default';
    const project = getSettings().adoProject || 'default';
    return `${folder}:${project}`;
  }

  private get sessionsStorageKey(): string {
    return `adoCode.sessions:${this.sessionKey}`;
  }

  private get activeSessionKey(): string {
    return `adoCode.activeSessionId:${this.sessionKey}`;
  }

  private getSessions(): Session[] {
    return this._context.workspaceState.get<Session[]>(this.sessionsStorageKey, []);
  }

  private async saveSessions(sessions: Session[]): Promise<void> {
    await this._context.workspaceState.update(this.sessionsStorageKey, sessions);
  }

  private getActiveSessionId(): string | null {
    return this._context.workspaceState.get<string | null>(this.activeSessionKey, null);
  }

  private async setActiveSessionId(id: string): Promise<void> {
    await this._context.workspaceState.update(this.activeSessionKey, id);
  }

  /** Migrate old single-conversation format to session format. */
  private async migrateFromLegacyHistory(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'default';
    const legacyKey = `adoCode.chatHistory:${folder}`;
    const legacy = this._context.workspaceState.get<LlmMessage[]>(legacyKey, []);
    if (legacy.length === 0) return;

    // Check if sessions already exist (no migration needed)
    const existing = this.getSessions();
    if (existing.length > 0) return;

    // Wrap legacy messages into a single session
    const session: Session = {
      id: new Date(0).toISOString(), // epoch = legacy session
      name: 'Previous Session',
      createdAt: new Date(0).toISOString(),
      messages: legacy.map(m => ({ role: m.role, content: m.content })),
    };
    await this.saveSessions([session]);
    await this.setActiveSessionId(session.id);
    // Clean up legacy key
    await this._context.workspaceState.update(legacyKey, undefined);
  }
```

**Step 2: Update persistConversation to save to active session**

Replace `persistConversation()` (line 708-713):

```typescript
  private persistConversation(): void {
    const capped = this.conversation.slice(-50);
    const sessions = this.getSessions();
    const activeId = this.getActiveSessionId();
    const idx = sessions.findIndex(s => s.id === activeId);
    if (idx >= 0) {
      sessions[idx].messages = capped;
      // Auto-name from first user message if still default
      if (sessions[idx].name === 'New Session') {
        const firstUser = capped.find(m => m.role === 'user');
        if (firstUser) {
          sessions[idx].name = firstUser.content.slice(0, 60).replace(/\n/g, ' ');
        }
      }
    } else {
      // No active session — create one
      const id = new Date().toISOString();
      const firstUser = capped.find(m => m.role === 'user');
      sessions.push({
        id,
        name: firstUser ? firstUser.content.slice(0, 60).replace(/\n/g, ' ') : 'New Session',
        createdAt: id,
        messages: capped,
      });
      this.setActiveSessionId(id);
    }
    this.saveSessions(sessions);
  }
```

**Step 3: Update restoreConversation to load from active session**

Replace `restoreConversation()` (line 717-720):

```typescript
  public restoreConversation(history: LlmMessage[]): void {
    this.conversation = history.slice(-50);
    this.postMessage({ type: 'historyRestored', messages: this.conversation });
  }

  /** Load a specific session's messages into the conversation. */
  public async loadSession(sessionId: string): Promise<void> {
    const sessions = this.getSessions();
    const session = sessions.find(s => s.id === sessionId);
    if (!session) {
      this.postMessage({ type: 'error', message: `Session not found: ${sessionId}` });
      return;
    }
    this.conversation = session.messages.map(m => ({ role: m.role as any, content: m.content }));
    await this.setActiveSessionId(sessionId);
    this.postMessage({ type: 'historyRestored', messages: this.conversation });
  }

  /** Create a new empty session and make it active. */
  public async createNewSession(): Promise<void> {
    const id = new Date().toISOString();
    const sessions = this.getSessions();
    sessions.push({
      id,
      name: 'New Session',
      createdAt: id,
      messages: [],
    });
    await this.saveSessions(sessions);
    await this.setActiveSessionId(id);
    this.conversation = [];
    this.postMessage({ type: 'historyRestored', messages: [] });
    this.postMessage({ type: 'loading', loading: false });
  }

  /** Send the session list to the webview. */
  public sendSessionList(): void {
    const sessions = this.getSessions();
    const activeId = this.getActiveSessionId();
    this.postMessage({ type: 'sessionList', sessions, activeId });
  }
```

**Step 4: Handle new message types in onDidReceiveMessage**

Add cases in the `switch (message.type)` block (after the `clearConversation` case around line 240):

```typescript
          case 'listSessions':
            this.sendSessionList();
            break;
          case 'switchSession':
            await this.loadSession(message.sessionId);
            break;
          case 'newSession':
            await this.createNewSession();
            break;
          case 'renameSession': {
            const sessions = this.getSessions();
            const s = sessions.find(s => s.id === message.sessionId);
            if (s) {
              s.name = message.name;
              await this.saveSessions(sessions);
              this.sendSessionList();
            }
            break;
          }
          case 'deleteSession': {
            const sessions = this.getSessions().filter(s => s.id !== message.sessionId);
            await this.saveSessions(sessions);
            // If we deleted the active session, switch to the most recent
            if (this.getActiveSessionId() === message.sessionId) {
              if (sessions.length > 0) {
                await this.loadSession(sessions[sessions.length - 1].id);
              } else {
                await this.createNewSession();
              }
            } else {
              this.sendSessionList();
            }
            break;
          }
```

**Step 5: Update clearConversation to work within current session**

Modify the existing `clearConversation` case (line 230-240) — it should clear messages in the current session, not create a new one:

```typescript
          case 'clearConversation':
            this.llmAbort?.abort();
            this.consentBroker.rejectAll();
            this.conversation = [];
            this.persistConversation();
            this.postMessage({ type: 'historyRestored', messages: [] });
            this.postMessage({ type: 'loading', loading: false });
            break;
```
(This is unchanged — `persistConversation` now saves to the active session.)

**Step 6: Update startup to migrate + restore active session**

In `ChatViewProvider.resolveWebviewView()`, after the config is posted (around line 192), add migration and session list:

```typescript
    // Migrate legacy history format if needed
    await this.migrateFromLegacyHistory();
    // Send session list to webview
    this.sendSessionList();
    // Restore active session messages
    const activeId = this.getActiveSessionId();
    if (activeId) {
      const sessions = this.getSessions();
      const active = sessions.find(s => s.id === activeId);
      if (active && active.messages.length > 0) {
        this.conversation = active.messages.map(m => ({ role: m.role as any, content: m.content }));
        this.postMessage({ type: 'historyRestored', messages: this.conversation });
      }
    }
```

**Step 7: Update `/resume` slash command**

Modify the `resume` case in `executeSlashCommand()` (line 1031-1041):

```typescript
      case 'resume': {
        // List sessions for the user to pick
        const sessions = this.getSessions();
        if (sessions.length === 0) {
          vscode.window.showWarningMessage('ADO Code: no previous sessions.');
          return;
        }
        const pick = await vscode.window.showQuickPick(
          sessions.map(s => ({
            label: s.name,
            description: `${s.messages.length} messages — ${new Date(s.createdAt).toLocaleDateString()}`,
            id: s.id,
          })),
          { placeHolder: 'Pick a session to resume' }
        );
        if (pick) {
          await this.loadSession(pick.id);
          vscode.window.showInformationMessage(`ADO Code: resumed "${pick.label}".`);
        }
        break;
      }
```

**Step 8: Remove legacy persistConversation references**

Remove the old `persistConversation` and `restoreConversation` methods (they're replaced by the session-based versions above). Keep the `trimConversation` method as-is.

**Step 9: Verify compilation**

Run: `npm run compile`
Expected: clean

**Step 10: Commit**

```bash
git add src/webview/ChatViewProvider.ts
git commit -m "feat: session history persistence with migration from legacy format"
```

---

### Task 3: Update startup session restoration in extension.ts

**Objective:** Replace the old QuickPick-based history restore with the new session system.

**Files:**
- Modify: `src/extension.ts`

**Step 1: Remove old history restoration block**

Remove lines 540-548 (the old QuickPick "Continue previous chat session?" block):

```typescript
  // Q4: offer to restore persisted chat history (keyed by folder fsPath).
  const historyKey = `adoCode.chatHistory:${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'default'}`;
  const savedHistory = context.workspaceState.get<import('./llm/types').LlmMessage[]>(historyKey, []);
  if (savedHistory.length > 0) {
    const pick = await vscode.window.showQuickPick(['Yes', 'No'], { placeHolder: 'Continue previous chat session?' });
    if (pick === 'Yes') {
      chatProvider.restoreConversation(savedHistory);
    }
  }
```

The new system handles restoration in `resolveWebviewView()` (Task 2, Step 6). The webview gets the session list and active session messages via messages.

**Step 2: Verify compilation**

Run: `npm run compile`
Expected: clean

**Step 3: Commit**

```bash
git add src/extension.ts
git commit -m "refactor: remove legacy QuickPick session restore (now handled by session system)"
```

---

### Task 4: SessionHistory webview component

**Objective:** Build the session history dropdown UI that replaces the refresh button in the header.

**Files:**
- Create: `src/webview-ui/src/components/SessionHistory.tsx`

**Step 1: Create the SessionHistory component**

```tsx
import React, { useState, useRef, useEffect } from 'react';

interface Session {
  id: string;
  name: string;
  createdAt: string;
  messages: Array<{ role: string; content: string }>;
}

interface Props {
  sessions: Session[];
  activeId: string | null;
  onSwitch: (sessionId: string) => void;
  onNew: () => void;
  onRename: (sessionId: string, name: string) => void;
  onDelete: (sessionId: string) => void;
}

export function SessionHistory({ sessions, activeId, onSwitch, onNew, onRename, onDelete }: Props) {
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setEditingId(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleRename = (id: string) => {
    if (editName.trim()) {
      onRename(id, editName.trim());
    }
    setEditingId(null);
  };

  const sorted = [...sessions].sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  const active = sessions.find(s => s.id === activeId);

  return (
    <div className="session-history" ref={ref}>
      <button
        className="session-history-trigger"
        onClick={() => setOpen(!open)}
        title={active ? `Session: ${active.name}` : 'Session history'}
      >
        <span className="session-history-icon">🕐</span>
        <span className="session-history-label">{active?.name || 'Session'}</span>
        <span className="session-history-chevron">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="session-history-dropdown">
          <button className="session-history-new" onClick={() => { onNew(); setOpen(false); }}>
            + New Session
          </button>
          <div className="session-history-separator" />
          {sorted.length === 0 ? (
            <div className="session-history-empty">No sessions yet</div>
          ) : (
            sorted.map(s => (
              <div
                key={s.id}
                className={`session-history-item ${s.id === activeId ? 'active' : ''}`}
              >
                {editingId === s.id ? (
                  <input
                    className="session-history-rename-input"
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    onBlur={() => handleRename(s.id)}
                    onKeyDown={e => { if (e.key === 'Enter') handleRename(s.id); if (e.key === 'Escape') setEditingId(null); }}
                    autoFocus
                    onClick={e => e.stopPropagation()}
                  />
                ) : (
                  <button
                    className="session-history-item-btn"
                    onClick={() => { onSwitch(s.id); setOpen(false); }}
                    onDoubleClick={() => { setEditingId(s.id); setEditName(s.name); }}
                    title={`${s.messages.length} messages — double-click to rename`}
                  >
                    <span className="session-history-item-name">{s.name}</span>
                    <span className="session-history-item-meta">
                      {s.messages.length} msgs · {new Date(s.createdAt).toLocaleDateString()}
                    </span>
                  </button>
                )}
                {s.id !== activeId && (
                  <button
                    className="session-history-delete"
                    onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}
                    title="Delete session"
                  >
                    ×
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
```

**Step 2: Verify compilation**

Run: `npm run build:webview`
Expected: clean

**Step 3: Commit**

```bash
git add src/webview-ui/src/components/SessionHistory.tsx
git commit -m "feat: SessionHistory dropdown component"
```

---

### Task 5: Wire SessionHistory into App.tsx and move refresh to kebab

**Objective:** Add session state to App, render SessionHistory in the header, move refresh to kebab menu, handle new message types.

**Files:**
- Modify: `src/webview-ui/src/App.tsx`
- Modify: `src/webview-ui/src/components/KebabMenu.tsx` (no changes needed — items are passed in)

**Step 1: Add session state to App**

Add state variables after the existing state declarations (around line 82):

```tsx
  // Session history
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
```

Import `Session` from the types file (add to the import from `./types`).

**Step 2: Handle new message types in the useEffect handler**

Add cases in the `switch (msg.type)` block (after the `historyRestored` case around line 169):

```tsx
        case 'sessionList':
          setSessions(msg.sessions);
          setActiveSessionId(msg.activeId);
          break;
        case 'sessionSwitched':
          setMessages(msg.session.messages.map(m => ({ role: m.role, content: m.content })));
          setActiveSessionId(msg.session.id);
          break;
```

**Step 3: Add session action callbacks**

Add after the existing callbacks (around line 340):

```tsx
  const handleSwitchSession = useCallback((sessionId: string) => {
    vscode.postMessage({ type: 'switchSession', sessionId });
  }, []);

  const handleNewSession = useCallback(() => {
    vscode.postMessage({ type: 'newSession' });
    setMessages([]);
    setLoading(false);
    setDraft('');
  }, []);

  const handleRenameSession = useCallback((sessionId: string, name: string) => {
    vscode.postMessage({ type: 'renameSession', sessionId, name });
  }, []);

  const handleDeleteSession = useCallback((sessionId: string) => {
    vscode.postMessage({ type: 'deleteSession', sessionId });
  }, []);
```

**Step 4: Update kebab menu items to include refresh**

Change the KebabMenu items prop (around line 410-414):

```tsx
        <KebabMenu
          items={[
            { label: 'Refresh Work Items', icon: '↻', action: 'refreshWorkItems' },
            { label: 'Rerun Setup Wizard', icon: '🔄', action: 'rerunWizard' },
            { label: 'Configuration…', icon: '⚙', action: 'openSettings' },
          ]}
          onSelect={handleKebabAction}
        />
```

**Step 5: Add refreshWorkItems to kebab action handler**

Update `handleKebabAction` (around line 307-316):

```tsx
  const handleKebabAction = useCallback((action: string) => {
    switch (action) {
      case 'refreshWorkItems':
        vscode.postMessage({ type: 'fetchWorkItems' });
        break;
      case 'rerunWizard':
        vscode.postMessage({ type: 'rerunWizard' });
        break;
      case 'openSettings':
        vscode.postMessage({ type: 'openSettings' });
        break;
    }
  }, []);
```

**Step 6: Replace the refresh button with SessionHistory in the header**

Replace the header section (around line 398-416):

```tsx
      {/* Chat header with session history + project switcher + kebab menu */}
      <div className="chat-header">
        <span className="chat-header-title">ADO Code</span>
        <SessionHistory
          sessions={sessions}
          activeId={activeSessionId}
          onSwitch={handleSwitchSession}
          onNew={handleNewSession}
          onRename={handleRenameSession}
          onDelete={handleDeleteSession}
        />
        <ProjectSwitcher
          projects={projects}
          current={config.adoProject}
          loading={projectsLoading}
          onSwitch={handleSwitchProject}
          onRefresh={handleFetchProjects}
        />
        <KebabMenu
          items={[
            { label: 'Refresh Work Items', icon: '↻', action: 'refreshWorkItems' },
            { label: 'Rerun Setup Wizard', icon: '🔄', action: 'rerunWizard' },
            { label: 'Configuration…', icon: '⚙', action: 'openSettings' },
          ]}
          onSelect={handleKebabAction}
        />
      </div>
```

**Step 7: Request session list on mount**

In the `useEffect` handler initialization (around line 237-238), add:

```tsx
    vscode.postMessage({ type: 'getConfig' });
    vscode.postMessage({ type: 'listAgents' });
    vscode.postMessage({ type: 'listSessions' });  // <-- add this
```

**Step 8: Remove the old handleRefreshWorkItems callback**

Remove the `handleRefreshWorkItems` callback (lines 335-337) — it's now handled by the kebab action handler.

**Step 9: Verify compilation**

Run: `npm run build:webview`
Expected: clean

**Step 10: Commit**

```bash
git add src/webview-ui/src/App.tsx
git commit -m "feat: wire SessionHistory into header, move refresh to kebab menu"
```

---

### Task 6: Session history CSS styles

**Objective:** Style the SessionHistory component to match the existing VS Code sidebar aesthetic.

**Files:**
- Modify: `src/webview-ui/src/styles/app.css`

**Step 1: Add session history styles**

Add after the `.header-refresh-btn:hover` block (around line 954), replacing the old `.header-refresh-btn` styles:

```css
/* ── Session History ─────────────────────────────────────────── */
.session-history {
  position: relative;
  flex-shrink: 0;
}

.session-history-trigger {
  display: flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: 1px solid var(--vscode-input-border);
  border-radius: 3px;
  color: var(--vscode-descriptionForeground);
  font-size: 0.78em;
  padding: 2px 8px;
  cursor: pointer;
  max-width: 180px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  transition: color 0.1s, border-color 0.1s;
}

.session-history-trigger:hover {
  color: var(--vscode-textLink-foreground);
  border-color: var(--vscode-textLink-foreground);
}

.session-history-icon {
  font-size: 0.9em;
}

.session-history-label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-history-chevron {
  font-size: 0.7em;
  opacity: 0.6;
}

.session-history-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 100;
  min-width: 240px;
  max-width: 320px;
  max-height: 300px;
  overflow-y: auto;
  background: var(--vscode-dropdown-background);
  border: 1px solid var(--vscode-dropdown-border);
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  margin-top: 4px;
}

.session-history-new {
  display: block;
  width: 100%;
  padding: 8px 12px;
  background: none;
  border: none;
  color: var(--vscode-textLink-foreground);
  font-size: 0.82em;
  text-align: left;
  cursor: pointer;
}

.session-history-new:hover {
  background: var(--vscode-list-hoverBackground);
}

.session-history-separator {
  height: 1px;
  background: var(--vscode-dropdown-border);
  margin: 2px 0;
}

.session-history-empty {
  padding: 8px 12px;
  color: var(--vscode-descriptionForeground);
  font-size: 0.82em;
  font-style: italic;
}

.session-history-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0;
}

.session-history-item.active {
  background: var(--vscode-list-activeSelectionBackground);
}

.session-history-item-btn {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  padding: 6px 12px;
  background: none;
  border: none;
  color: var(--vscode-dropdown-foreground);
  font-size: 0.82em;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
}

.session-history-item-btn:hover {
  background: var(--vscode-list-hoverBackground);
}

.session-history-item-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.session-history-item-meta {
  font-size: 0.9em;
  color: var(--vscode-descriptionForeground);
  opacity: 0.7;
}

.session-history-rename-input {
  flex: 1;
  padding: 4px 8px;
  margin: 4px 8px;
  font-size: 0.82em;
  font-family: var(--vscode-font-family);
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
  border-radius: 2px;
  outline: none;
}

.session-history-delete {
  background: none;
  border: none;
  color: var(--vscode-descriptionForeground);
  font-size: 1em;
  padding: 4px 8px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.1s;
}

.session-history-item:hover .session-history-delete {
  opacity: 1;
}

.session-history-delete:hover {
  color: var(--vscode-errorForeground);
}
```

**Step 2: Remove old `.header-refresh-btn` styles**

Remove the old `.header-refresh-btn` and `.header-refresh-btn:hover` CSS rules (lines 938-954) since the refresh button is no longer in the header.

**Step 3: Verify build**

Run: `npm run build:webview`
Expected: clean

**Step 4: Commit**

```bash
git add src/webview-ui/src/styles/app.css
git commit -m "feat: add SessionHistory styles, remove old header refresh button styles"
```

---

### Task 7: Update existing conversation tests

**Objective:** Update the existing conversation tests to work with the new session-based persistence.

**Files:**
- Modify: `src/test/suite/webview/conversation.test.ts`

**Step 1: Rewrite conversation tests for session format**

```typescript
import * as assert from 'assert';
import { ChatViewProvider } from '../../../webview/ChatViewProvider';

function makeProvider(saved: Record<string, any> = {}) {
  return new ChatViewProvider(
    { fsPath: '/tmp/x' } as any,
    {} as any,
    { workspaceState: { get: (k: string) => saved[k], update: async (k: string, v: any) => { saved[k] = v; } } } as any
  );
}

suite('Session history persistence', () => {
  test('createNewSession adds a session and sets it active', async () => {
    const saved: Record<string, any> = {};
    const provider = makeProvider(saved);
    const sent: any[] = [];
    (provider as any).postMessage = (m: any) => sent.push(m);

    await provider.createNewSession();

    const sessions = (provider as any).getSessions();
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].name, 'New Session');
    assert.strictEqual((provider as any).getActiveSessionId(), sessions[0].id);
  });

  test('loadSession restores messages from a session', async () => {
    const saved: Record<string, any> = {};
    const provider = makeProvider(saved);
    const sent: any[] = [];
    (provider as any).postMessage = (m: any) => sent.push(m);

    // Create a session with messages
    await provider.createNewSession();
    const sessions = (provider as any).getSessions();
    sessions[0].messages = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }];
    await (provider as any).saveSessions(sessions);

    // Load it
    await provider.loadSession(sessions[0].id);
    const restored = sent.find(m => m.type === 'historyRestored');
    assert.ok(restored);
    assert.strictEqual(restored.messages.length, 2);
    assert.strictEqual(restored.messages[0].content, 'hello');
  });

  test('deleteSession removes session and switches if active', async () => {
    const saved: Record<string, any> = {};
    const provider = makeProvider(saved);
    const sent: any[] = [];
    (provider as any).postMessage = (m: any) => sent.push(m);

    await provider.createNewSession();
    const id1 = (provider as any).getActiveSessionId();

    await provider.createNewSession();
    const id2 = (provider as any).getActiveSessionId();

    // Delete the active session (id2)
    await (provider as any).handleMessage({ type: 'deleteSession', sessionId: id2 });

    const sessions = (provider as any).getSessions();
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].id, id1);
  });

  test('migrateFromLegacyHistory wraps old format into session', async () => {
    const saved: Record<string, any> = {
      'adoCode.chatHistory:/tmp/x': [
        { role: 'user', content: 'old msg' },
        { role: 'assistant', content: 'old reply' },
      ],
    };
    const provider = makeProvider(saved);
    await (provider as any).migrateFromLegacyHistory();

    const sessions = (provider as any).getSessions();
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].messages.length, 2);
    assert.strictEqual(sessions[0].messages[0].content, 'old msg');
    // Legacy key should be removed
    assert.strictEqual(saved['adoCode.chatHistory:/tmp/x'], undefined);
  });

  test('migrateFromLegacyHistory skips if sessions already exist', async () => {
    const saved: Record<string, any> = {
      'adoCode.chatHistory:/tmp/x': [{ role: 'user', content: 'old' }],
    };
    const provider = makeProvider(saved);
    // Pre-populate sessions
    await provider.createNewSession();
    const beforeCount = (provider as any).getSessions().length;

    await (provider as any).migrateFromLegacyHistory();

    // Should not add another session
    assert.strictEqual((provider as any).getSessions().length, beforeCount);
  });

  test('persistConversation saves to active session', async () => {
    const saved: Record<string, any> = {};
    const provider = makeProvider(saved);
    await provider.createNewSession();
    const activeId = (provider as any).getActiveSessionId();

    (provider as any).conversation = [
      { role: 'user', content: 'test message' },
      { role: 'assistant', content: 'test reply' },
    ];
    (provider as any).persistConversation();

    const sessions = (provider as any).getSessions();
    const active = sessions.find((s: any) => s.id === activeId);
    assert.ok(active);
    assert.strictEqual(active.messages.length, 2);
    assert.strictEqual(active.messages[0].content, 'test message');
  });
});
```

**Step 2: Run tests**

Run: `npm test`
Expected: all tests pass

**Step 3: Commit**

```bash
git add src/test/suite/webview/conversation.test.ts
git commit -m "test: update conversation tests for session-based persistence"
```

---

### Task 8: Full verification

**Objective:** Run all verification steps to ensure everything compiles, tests pass, and the build is clean.

**Step 1: TypeScript compilation**

Run: `npm run compile`
Expected: clean (no errors)

**Step 2: Webview build**

Run: `npm run build:webview`
Expected: clean

**Step 3: Lint**

Run: `npm run lint`
Expected: no errors

**Step 4: Tests**

Run: `npm test`
Expected: all tests pass (83+ tests)

**Step 5: Package (optional sanity check)**

Run: `npx vsce package --allow-missing-repository`
Expected: produces a .vsix file

---

## Risks & Tradeoffs

1. **workspaceState size limit** — VS Code workspaceState is backed by a JSON file, typically ~2MB. With 50 messages per session and ~20 sessions, worst case is ~20 * 50 * 500 bytes ≈ 500KB. Safe margin.

2. **Migration** — Single-shot migration from legacy `chatHistory` to sessions. Clean and atomic — deletes old key after wrapping.

3. **Backward compatibility** — The `/clear` command now clears messages in the current session (doesn't delete the session). This is intentional — sessions persist even when cleared.

4. **Session naming** — Auto-generated from first user message (60 char truncation). Double-click to rename. Simple and discoverable.

5. **Project switch** — When switching ADO projects, the session list changes (sessions are per-project). The old session list disappears; the new project's sessions appear. This is correct behavior per the requirement.

6. **No auto-refresh removal** — The 5-minute auto-refresh timer in `resolveWebviewView` stays. Only the manual button moves to kebab.
