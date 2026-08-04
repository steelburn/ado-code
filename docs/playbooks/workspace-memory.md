# Playbook: Workspace Memory

How ADO Code stores and manages per-workspace memory (shared team context,
project-specific settings, and git-tracked knowledge).

## Overview

Workspace memory lives in the project repository and is shared with the
team via git. It stores:

- Project-specific conventions and rules
- Team-shared context and decisions
- Build/test commands and workflows
- Architecture notes and patterns

## Storage Location

Workspace memory lives in `.ado-code/` at the project root:

```
.ado-code/
├── memory/
│   ├── conventions.md      # Code style and conventions
│   ├── architecture.md     # Architecture notes
│   ├── commands.md         # Build, test, deploy commands
│   ├── decisions.md        # ADR-style decisions
│   └── context.md          # Project-specific context
├── settings.json           # Workspace-specific settings (optional)
└── .gitignore              # Exclude sensitive files if needed
```

## Setup

### Create the directory structure

```bash
mkdir -p .ado-code/memory
```

### Add to .gitignore (if needed)

```gitignore
# .ado-code/memory/ is tracked — this is intentional for team sharing
# Only ignore sensitive files:
.ado-code/settings.json  # if it contains secrets
```

### Initialize with templates

```bash
# Create memory files
cat > .ado-code/memory/conventions.md << 'EOF'
# Code Conventions

## TypeScript
- Use strict mode
- Prefer interfaces over types for object shapes
- Use async/await over callbacks

## Testing
- One test file per source file
- Use describe/it blocks
- Mock external dependencies
EOF

cat > .ado-code/memory/commands.md << 'EOF'
# Project Commands

## Build
- `npm run build` — compile TypeScript
- `npm run watch` — watch mode

## Test
- `npm test` — run all tests
- `npm run test:unit` — unit tests only
- `npm run test:integration` — integration tests

## Lint
- `npm run lint` — ESLint
- `npm run format` — Prettier
EOF
```

## Reading Workspace Memory

### From the Extension

```typescript
import * as vscode from 'vscode'
import * as fs from 'fs/promises'
import * as path from 'path'

async function readWorkspaceMemory(
  filename: string,
): Promise<string | undefined> {
  const root = vscode.workspace.workspaceFolders?.[0]
  if (!root) return undefined

  const memoryPath = path.join(root.uri.fsPath, '.ado-code', 'memory', filename)
  try {
    return await fs.readFile(memoryPath, 'utf-8')
  } catch {
    return undefined
  }
}

// Usage:
const conventions = await readWorkspaceMemory('conventions.md')
const commands = await readWorkspaceMemory('commands.md')
```

### Inject into System Prompt

```typescript
async function buildWorkspaceContext(): Promise<string> {
  const files = ['conventions.md', 'architecture.md', 'commands.md']
  const parts: string[] = []

  for (const file of files) {
    const content = await readWorkspaceMemory(file)
    if (content) {
      const title = file.replace('.md', '').replace(/^\w/, c => c.toUpperCase())
      parts.push(`## ${title}\n${content}`)
    }
  }

  return parts.length > 0
    ? `\n\n## Project Context\n${parts.join('\n\n')}`
    : ''
}
```

### From the Chat System Prompt

Workspace memory is loaded once when the workspace opens and injected
into every LLM request:

```typescript
// In ChatViewProvider or prompt builder:
const workspaceContext = await buildWorkspaceContext()
const systemPrompt = `You are ADO Code.${workspaceContext}

... rest of prompt ...`
```

## Writing Workspace Memory

### From Chat Commands

```
/conventions Always use strict TypeScript mode
/commands Add: npm run deploy → deploys to staging
/architecture The API follows REST with /api/v1 prefix
```

Implementation:

```typescript
if (content.startsWith('/conventions ')) {
  const text = content.slice('/conventions '.length).trim()
  const memoryPath = path.join(rootPath, '.ado-code', 'memory', 'conventions.md')
  const existing = await readWorkspaceMemory('conventions.md') || ''
  await fs.appendFile(memoryPath, `\n- ${text}\n`)
  return { type: 'assistantMessage', content: `Added to conventions.`, done: true }
}
```

### From Code

```typescript
async function writeWorkspaceMemory(
  filename: string,
  content: string,
  append = true,
): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]
  if (!root) throw new Error('No workspace folder')

  const memoryPath = path.join(root.uri.fsPath, '.ado-code', 'memory', filename)

  if (append) {
    await fs.appendFile(memoryPath, `\n${content}\n`)
  } else {
    await fs.writeFile(memoryPath, content, 'utf-8')
  }
}
```

## Git Integration

### Committing Workspace Memory

Workspace memory files are regular git-tracked files. To commit them:

```bash
git add .ado-code/memory/
git commit -m "docs: update project conventions"
git push
```

### Pulling Team Memory

When team members pull, they get the latest workspace memory:

```bash
git pull  # Includes .ado-code/memory/ updates
```

### Conflict Resolution

Memory files are plain markdown — conflicts resolve like any other file.
Use standard git merge/rebase workflow.

### Branch-Specific Memory

For branch-specific context (e.g., feature branch conventions):

```bash
# Feature branch memory
mkdir -p .ado-code/branches/feature-x/memory
```

## Memory Categories

| File | Purpose | Example |
|------|---------|---------|
| `conventions.md` | Code style, patterns | "Use tabs, not spaces" |
| `architecture.md` | System design notes | "API uses REST + WebSocket" |
| `commands.md` | Build/test/deploy commands | "npm run deploy:staging" |
| `decisions.md` | ADRs and team decisions | "Chose PostgreSQL over MongoDB" |
| `context.md` | Project-specific context | "Monorepo with 3 packages" |

## Automatic Memory Population

ADO Code can auto-populate memory from workspace analysis:

```typescript
async function analyzeWorkspace(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]
  if (!root) return

  // Detect package manager
  const hasPackageJson = await fileExists(path.join(root.uri.fsPath, 'package.json'))
  const hasCargoToml = await fileExists(path.join(root.uri.fsPath, 'Cargo.toml'))

  // Auto-generate commands.md
  if (hasPackageJson) {
    const pkg = JSON.parse(await fs.readFile(path.join(root.uri.fsPath, 'package.json'), 'utf-8'))
    const scripts = Object.keys(pkg.scripts || {}).map(s => `- npm run ${s}`)
    if (scripts.length > 0) {
      await writeWorkspaceMemory('commands.md', `# Available Scripts\n${scripts.join('\n')}`)
    }
  }
}
```

## Pitfalls

- **Sensitive data**: Don't put API keys, passwords, or secrets in
  workspace memory files — they're git-tracked and shared with the team.
- **Large files**: Keep memory files under 10KB each. They're loaded
  into the system prompt for every LLM request.
- **Binary files**: Memory files must be plain text (markdown, JSON, etc.).
  Don't store images or binary data.
- **Path safety**: Always resolve paths relative to the workspace root
  and validate they don't escape with `../`.
- **Git conflicts**: Multiple team members editing the same memory file
  will cause git conflicts. Use descriptive commit messages and resolve
  promptly.

## File Checklist

| File | Action |
|------|--------|
| `.ado-code/memory/conventions.md` | Create/edit |
| `.ado-code/memory/architecture.md` | Create/edit |
| `.ado-code/memory/commands.md` | Create/edit |
| `.ado-code/memory/decisions.md` | Create/edit |
| `.ado-code/memory/context.md` | Create/edit |
| `.gitignore` | Edit (if excluding sensitive files) |
| `src/llm/prompts/system.ts` | Edit (inject workspace memory) |
| `src/webview/ChatViewProvider.ts` | Edit (handle /conventions, /commands, etc.) |
