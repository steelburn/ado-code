export type AgentName = 'claude' | 'codex' | 'opencode' | 'hermes' | 'pi' | 'openclaw' | 'aider' | 'gemini' | 'cursor-agent' | 'dsh';

export interface AgentCapability {
  name: AgentName;
  displayName: string;
  installed: boolean;
  version?: string;
  /** Resolved executable that answered the version probe — `claude.cmd` for
   *  npm installs on Windows, `claude.exe` for native installs, `claude`
   *  elsewhere. Adapters spawn THIS exact binary (see resolveSpawn) so
   *  detection and execution always agree. */
  bin?: string;
  /** Modes the adapter supports */
  modes: ('one-shot' | 'session')[];
}

export interface AgentRun {
  id: string;               // local run id (e.g. run-<timestamp>-<workItemId>)
  workItemId?: number;
  agent: AgentName;
  /** Resolved agent executable to spawn (recorded from detection — e.g.
   *  `claude.cmd` on Windows npm installs). Adapters fall back to their
   *  canonical name when absent (runs started before this field existed). */
  bin?: string;
  title?: string;           // ADO work item title (commit/PR message defaults)
  sessionId?: string;       // external agent's session id (for resume)
  /** Chat session (adoCode session id) that delegated this run — the chat
   *  thread that started it, used to route progress/conclusion updates into
   *  the correct session even after the user switches chats. */
  chatSessionId?: string;
  workdir: string;
  branch?: string;          // git branch this run is working on
  worktreePath?: string;    // isolated worktree directory (for concurrent runs)
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'; // interrupted: extension reloaded mid-run (Q7)
  startedAt: string;
  finishedAt?: string;
  outputFile?: string;      // captured stdout/stderr
  summary?: string;         // final result text
  childIds?: number[];      // descendant work item ids delegated with this parent run (delivery checklist)
  deliveryReport?: string;  // '## Delivery Report' section extracted from the agent's output
}
