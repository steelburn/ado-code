# Playbook: Adding a New Agent Adapter

How to add support for a new external agent CLI (e.g. Claude Code, Codex,
OpenCode, etc.).

## Overview

Agent adapters bridge between ADO Code's delegation system and external
agent CLIs. Each adapter knows how to:

- Spawn the agent's CLI binary
- Send a one-shot prompt
- Optionally resume a previous session
- Extract session IDs from output

## Steps

### 1. Add the agent name to `AgentName`

In `src/agents/types.ts`:

```typescript
export type AgentName = 'claude' | 'codex' | /* ... */ | 'newagent';
```

### 2. Create the adapter

Create `src/agents/adapters/NewAgentAdapter.ts`:

```typescript
import * as cp from 'child_process'
import { AgentAdapter } from './types'
import { AgentRun } from '../types'

export type SpawnFn = (bin: string, args: string[], opts: any) => any

export class NewAgentAdapter implements AgentAdapter {
  readonly name = 'newagent'

  constructor(private spawnFn: SpawnFn = cp.spawn) {}

  private spawn(
    args: string[],
    cwd: string,
    signal?: AbortSignal,
    onChunk?: (chunk: string) => void,
  ): Promise<{ exitCode: number | null; output: string }> {
    return new Promise((resolve) => {
      const child = this.spawnFn('newagent', args, { cwd, signal }) as any
      let output = ''
      child.stdout.on('data', (d: any) => {
        const text = d.toString()
        output += text
        onChunk?.(text)
      })
      child.stderr.on('data', (d: any) => {
        const text = d.toString()
        output += text
        onChunk?.(text)
      })
      child.on('error', (err: any) =>
        resolve({ exitCode: 1, output: `failed to spawn: ${err.message}` }),
      )
      child.on('close', (code: number | null) => resolve({ exitCode: code, output }))
    })
  }

  runTask(
    run: AgentRun,
    prompt: string,
    signal?: AbortSignal,
    onChunk?: (chunk: string) => void,
  ) {
    const args = ['--prompt', prompt, '--output', 'json']
    return this.spawn(args, run.workdir, signal, onChunk)
  }

  // Optional: implement if the agent supports session resume
  resumeTask?(
    run: AgentRun,
    followUp: string,
    signal?: AbortSignal,
    onChunk?: (chunk: string) => void,
  ) {
    if (!run.sessionId) throw new Error('no session id to resume')
    return this.spawn(
      ['--prompt', followUp, '--resume', run.sessionId],
      run.workdir, signal, onChunk,
    )
  }

  // Optional: extract session id from agent output for resume
  extractSessionId?(output: string): string | undefined {
    try {
      const parsed = JSON.parse(output)
      return parsed.session_id
    } catch {
      return undefined
    }
  }
}
```

### 3. Register in the adapter index

In `src/agents/adapters/index.ts`:

```typescript
import { NewAgentAdapter } from './NewAgentAdapter'

export function createAdapter(name: AgentName): AgentAdapter {
  switch (name) {
    // ... existing cases ...
    case 'newagent': return new NewAgentAdapter()
    default: return new GenericAdapter(name)
  }
}
```

### 4. Add the AgentSpec

In `src/agents/registry.ts`, add to `AGENT_SPECS`:

```typescript
newagent: {
  name: 'newagent',
  displayName: 'New Agent',
  bin: 'newagent',                    // binary to probe
  versionFlag: ['--version'],         // flag to check installed
  oneShot: () => ['--prompt'],        // base args for one-shot
  session: () => ['--prompt', '--resume'], // base args for session
  supportsSession: true,              // whether session resume is supported
},
```

### 5. Add configuration (if needed)

If the agent needs custom config (API keys, URLs, etc.), add settings
in `src/config/settings.ts`:

```typescript
export interface AdoCodeSettings {
  // ... existing ...
  newagentApiKey?: string
}
```

And read them in `getSettings()`:

```typescript
newagentApiKey: config.get<string>('newagent.apiKey', ''),
```

### 6. Enable in VS Code settings

Users enable agents via `adoCode.agents.enabled`:

```json
{
  "adoCode.agents.enabled": ["claude", "codex", "newagent"]
}
```

### 7. Write tests

Create `src/test/suite/agents/newagentAdapter.test.ts`:

```typescript
import * as assert from 'assert'
import { NewAgentAdapter } from '../../../agents/adapters/NewAgentAdapter'

suite('NewAgentAdapter', () => {
  const adapter = new NewAgentAdapter()

  test('has correct name', () => {
    assert.strictEqual(adapter.name, 'newagent')
  })

  test('runTask spawns with correct args', async () => {
    // Mock spawnFn to capture args
    const calls: any[] = []
    const mockSpawn: SpawnFn = (bin, args, opts) => {
      calls.push({ bin, args, opts })
      // Return a mock child process
      return createMockChild()
    }
    const adapter = new NewAgentAdapter(mockSpawn)

    await adapter.runTask(
      { id: 'run-1', agent: 'newagent', workdir: '/tmp', status: 'running', startedAt: new Date().toISOString() },
      'do something',
    )

    assert.strictEqual(calls[0].bin, 'newagent')
    assert.ok(calls[0].args.includes('do something'))
  })
})
```

## Adapter Interface Reference

```typescript
export interface AgentAdapter {
  readonly name: string

  /** Launch a one-shot task; resolves when the agent exits.
   *  exitCode null = aborted/killed. */
  runTask(
    run: AgentRun,
    prompt: string,
    signal?: AbortSignal,
    onChunk?: (chunk: string) => void,
  ): Promise<{ exitCode: number | null; output: string }>

  /** Resume a previous session with a follow-up prompt. */
  resumeTask?(
    run: AgentRun,
    followUp: string,
    signal?: AbortSignal,
    onChunk?: (chunk: string) => void,
  ): Promise<{ exitCode: number | null; output: string }>

  /** Extract the external session id from one-shot output. */
  extractSessionId?(output: string): string | undefined
}
```

## Pitfalls

- **Session resume**: If `supportsSession` is true in the AgentSpec,
  the runner will call `resumeTask()` on follow-up prompts. If the
  agent doesn't support it, set `supportsSession: false` and the runner
  will synthesize follow-ups (H13 pattern).
- **Spawn injection**: On Windows, `execFile` needs `shell: true` to
  run `.cmd` shims. The registry probes with shell on win32 (M-7 fix).
- **Output parsing**: `onChunk` streams raw stdout to the UI. The final
  `output` string is used for summary extraction. Make sure your agent
  can output parseable JSON when `--output json` is passed.
- **Binary probing**: The registry runs `<bin> --version` with a 5s
  timeout. If your binary doesn't support `--version`, use another
  lightweight flag.

## File Checklist

| File | Action |
|------|--------|
| `src/agents/types.ts` | Edit (add to AgentName union) |
| `src/agents/adapters/NewAgentAdapter.ts` | Create |
| `src/agents/adapters/index.ts` | Edit (add case to createAdapter) |
| `src/agents/registry.ts` | Edit (add to AGENT_SPECS) |
| `src/config/settings.ts` | Edit (if custom config needed) |
| `src/test/suite/agents/newagentAdapter.test.ts` | Create |
