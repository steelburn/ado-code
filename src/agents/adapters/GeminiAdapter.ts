import * as cp from 'child_process';
import { AgentAdapter } from './types';
import { AgentName, AgentRun } from '../types';

/** Minimal spawn signature — loose enough for test fakes, matches cp.spawn. */
export type SpawnFn = (bin: string, args: string[], opts: any) => any;

/** Gemini CLI: `gemini -p "<prompt>"` one-shot; resume via `gemini -c` (most recent session). */
export class GeminiAdapter implements AgentAdapter {
  readonly name = 'gemini';

  constructor(private spawnFn: SpawnFn = cp.spawn) {}

  private spawn(args: string[], cwd: string, signal?: AbortSignal): Promise<{ exitCode: number | null; output: string }> {
    return new Promise((resolve) => {
      const child = this.spawnFn('gemini', args, { cwd, signal }) as any;
      let output = '';
      child.stdout.on('data', (d: any) => { output += d.toString(); });
      child.stderr.on('data', (d: any) => { output += d.toString(); });
      child.on('error', (err: any) => resolve({ exitCode: 1, output: `failed to spawn: ${err.message}` }));
      child.on('close', (code: number | null) => resolve({ exitCode: code, output }));
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
