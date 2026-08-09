import * as cp from 'child_process';
import { AgentAdapter } from './types';
import { AgentName, AgentRun } from '../types';

/** Minimal spawn signature — loose enough for test fakes, matches cp.spawn. */
export type SpawnFn = (bin: string, args: string[], opts: any) => any;

/** Codex CLI: `codex exec --sandbox workspace-write "<prompt>"`. No session resume — follow-ups re-run with prior context. */
export class CodexAdapter implements AgentAdapter {
  readonly name = 'codex';

  constructor(private spawnFn: SpawnFn = cp.spawn) {}

  private spawn(args: string[], cwd: string, signal?: AbortSignal): Promise<{ exitCode: number | null; output: string }> {
    return new Promise((resolve) => {
      try {
        const child = this.spawnFn('codex', args, { cwd, signal }) as any;
        let output = '';
        child.stdout.on('data', (d: any) => { output += d.toString(); });
        child.stderr.on('data', (d: any) => { output += d.toString(); });
        child.on('error', (err: any) => resolve({ exitCode: 1, output: `failed to spawn: ${err.message}` }));
        child.on('close', (code: number | null) => resolve({ exitCode: code, output }));
      } catch (err: any) {
        // Synchronous spawn failure (e.g. ELOOP, ENOENT on some platforms)
        resolve({ exitCode: 1, output: `failed to spawn: ${err.message ?? err}` });
      }
    });
  }

  runTask(run: AgentRun, prompt: string, signal?: AbortSignal) {
    return this.spawn(['exec', '--sandbox', 'workspace-write', '--json', prompt], run.workdir, signal);
  }

  // No resumeTask — H13: synthesized follow-up (fresh prompt with prior context).
}
