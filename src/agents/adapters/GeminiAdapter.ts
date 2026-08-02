import * as cp from 'child_process';
import { AgentAdapter } from './types';
import { AgentRun } from '../types';

/** Gemini CLI: `gemini -p "<prompt>"` one-shot; resume via `gemini -c` (most recent session). */
export class GeminiAdapter implements AgentAdapter {
  readonly name = 'gemini';

  private spawn(args: string[], cwd: string, signal?: AbortSignal): Promise<{ exitCode: number | null; output: string }> {
    return new Promise((resolve) => {
      const child = cp.spawn('gemini', args, { cwd, signal });
      let output = '';
      child.stdout.on('data', d => { output += d.toString(); });
      child.stderr.on('data', d => { output += d.toString(); });
      child.on('error', err => resolve({ exitCode: 1, output: `failed to spawn: ${err.message}` }));
      child.on('close', code => resolve({ exitCode: code, output }));
    });
  }

  runTask(run: AgentRun, prompt: string, signal?: AbortSignal) {
    return this.spawn(['-p', prompt], run.workdir, signal);
  }

  resumeTask(run: AgentRun, followUp: string, signal?: AbortSignal) {
    // gemini -c resumes the most recent session; the follow-up is the next prompt.
    return this.spawn(['-c', followUp], run.workdir, signal);
  }
}
