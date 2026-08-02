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
