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
