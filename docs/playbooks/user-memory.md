# Playbook: User Memory

How ADO Code stores and manages per-user memory (preferences, context,
and learned information).

## Overview

User memory persists across sessions using VS Code's `globalState` API.
It survives workspace switches, extension reloads, and VS Code restarts.
Memory is used to:

- Remember user preferences and preferences
- Store learned context (e.g., "user prefers tabs over spaces")
- Track conversation history for continuity
- Cache resolved settings (e.g., active organization)

## Storage Location

User memory lives in VS Code's `globalState` — a key-value store
persisted to disk per extension:

```
~/.config/Code/User/globalStorage/<extension-id>/
```

Key naming convention: `adoCode.<category>.<key>`

## Categories

### 1. Active Organization

```typescript
// Store the user's active ADO organization
await context.globalState.update('adoCode.activeOrgName', 'my-org')
await context.globalState.update('adoCode.activeProject', 'my-project')
```

### 2. User Preferences

```typescript
// Remember user choices
await context.globalState.update('adoCode.preferredAgent', 'claude')
await context.globalState.update('adoCode.preferredMode', 'inline')
```

### 3. Conversation History

```typescript
// Persist conversation for continuity
await context.globalState.update('adoCode.conversation', {
  messages: [...],
  lastWorkItem: 12345,
  timestamp: Date.now(),
})
```

### 4. Settings Cache

```typescript
// Cache resolved settings to avoid repeated lookups
await context.globalState.update('adoCode.settingsCache', {
  org: { name: 'my-org', url: '...', project: '...' },
  resolvedAt: Date.now(),
})
```

## Implementation

### Reading Memory

```typescript
import * as vscode from 'vscode'

function getUserMemory(context: vscode.ExtensionContext, key: string, defaultValue?: any) {
  return context.globalState.get(`adoCode.${key}`, defaultValue)
}

// Usage:
const preferredAgent = getUserMemory(context, 'preferredAgent', 'claude')
const conversation = getUserMemory(context, 'conversation')
```

### Writing Memory

```typescript
async function setUserMemory(context: vscode.ExtensionContext, key: string, value: any) {
  await context.globalState.update(`adoCode.${key}`, value)
}

// Usage:
await setUserMemory(context, 'preferredAgent', 'codex')
```

### Clearing Memory

```typescript
// Clear a specific key
await context.globalState.update('adoCode.preferredAgent', undefined)

// Clear all ADO Code memory
const keys = context.globalState.keys().filter(k => k.startsWith('adoCode.'))
for (const key of keys) {
  await context.globalState.update(key, undefined)
}
```

### Reset Memory

```typescript
// Reset to defaults
async function resetUserMemory(context: vscode.ExtensionContext) {
  const defaults: Record<string, any> = {
    'adoCode.preferredAgent': 'claude',
    'adoCode.preferredMode': 'inline',
    // ... other defaults
  }
  for (const [key, value] of Object.entries(defaults)) {
    await context.globalState.update(key, value)
  }
}
```

## slash Commands

ADO Code provides slash commands for memory management in the chat:

### /remember

Store a user preference or learned context:

```
/remember I prefer tabs over spaces
/remember Always use async/await
/remember My ADO org is MyCompany
```

Implementation in the chat handler:

```typescript
if (content.startsWith('/remember ')) {
  const fact = content.slice('/remember '.length).trim()
  const memories = context.globalState.get<string[]>('adoCode.userFacts', [])
  memories.push(fact)
  await context.globalState.update('adoCode.userFacts', memories)
  return { type: 'assistantMessage', content: `Remembered: "${fact}"`, done: true }
}
```

### /forget

Remove a previously stored memory:

```
/forget tabs over spaces
```

Implementation:

```typescript
if (content.startsWith('/forget ')) {
  const query = content.slice('/forget '.length).trim().toLowerCase()
  const memories = context.globalState.get<string[]>('adoCode.userFacts', [])
  const filtered = memories.filter(m => !m.toLowerCase().includes(query))
  await context.globalState.update('adoCode.userFacts', filtered)
  return { type: 'assistantMessage', content: `Forgot matching memories.`, done: true }
}
```

### /memory

List all stored memories:

```
/memory
```

Implementation:

```typescript
if (content === '/memory') {
  const memories = context.globalState.get<string[]>('adoCode.userFacts', [])
  if (memories.length === 0) {
    return { type: 'assistantMessage', content: 'No memories stored.', done: true }
  }
  const list = memories.map((m, i) => `${i + 1}. ${m}`).join('\n')
  return { type: 'assistantMessage', content: `Stored memories:\n${list}`, done: true }
}
```

## Using Memory in Prompts

Memory is injected into the system prompt for the LLM:

```typescript
function buildSystemPrompt(context: vscode.ExtensionContext): string {
  const memories = context.globalState.get<string[]>('adoCode.userFacts', [])
  const memoryBlock = memories.length > 0
    ? `\n\n## User Preferences\n${memories.map(m => `- ${m}`).join('\n')}`
    : ''

  return `You are ADO Code, an AI assistant for Azure DevOps.${memoryBlock}

... rest of prompt ...`
}
```

## Pitfalls

- **globalState size**: VS Code recommends keeping globalState under
  100KB. Store compact data, not large blobs.
- **No encryption**: globalState is stored as plaintext JSON on disk.
  Never store API keys or secrets in globalState (use `secrets` API).
- **No sync**: globalState does not sync across machines. Users with
  multiple dev environments need to set memory on each.
- **TTL cleanup**: Old conversation history should be pruned to
  prevent unbounded growth:
  ```typescript
  const MAX_CONVERSATION_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
  if (Date.now() - conversation.timestamp > MAX_CONVERSATION_AGE_MS) {
    await context.globalState.update('adoCode.conversation', undefined)
  }
  ```

## File Checklist

| File | Action |
|------|--------|
| `src/webview/ChatViewProvider.ts` | Edit (handle /remember, /forget, /memory) |
| `src/llm/prompts/system.ts` | Edit (inject memories into prompt) |
| `src/config/settings.ts` | Edit (if memory-related settings) |
