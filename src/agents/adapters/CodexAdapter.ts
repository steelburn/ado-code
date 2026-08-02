import * as cp from 'child_process';
import { AgentAdapter } from './types';
import { AgentRun } from '../types';

/** Codex CLI: `codex exec --sandbox workspace-write "<prompt>"`. No session resume — follow-ups re-run with prior context. */
export class CodexAdapter implements AgentAdapter {
  readonly name = 'codex';

  private spawn(args: string[], cwd: string, signal?: AbortSignal): Promise<{ exitCode: number | null; output: string }> {
    return new Promise((resolve) => {
      const child = cp.spawn('codex', args, { cwd, signal });
      let output = '';
      child.stdout.on('data', d => { output += d.toString(); });
      child.stderr.on('data', d => { output += d.toString(); });
      child.on('error', err => resolve({ exitCode: 1, output: `failed to spawn: ${err.message}` }));
      child.on('close', code => resolve({ exitCode: code, output }));
    });
  }

  runTask(run: AgentRun, prompt: string, signal?: AbortSignal) {
    return this.spawn(['exec', '--sandbox', 'workspace-write', '--json', prompt], run.workdir, signal);
  }

  // No resumeTask — H13: synthesized follow-up (fresh prompt with prior context).
}
