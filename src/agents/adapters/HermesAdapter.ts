import * as cp from 'child_process';
import { AgentAdapter } from './types';
import { AgentName, AgentRun } from '../types';

/** Minimal spawn signature — loose enough for test fakes, matches cp.spawn. */
export type SpawnFn = (bin: string, args: string[], opts: any) => any;

/** Hermes: `hermes chat -q "<prompt>"` one-shot; resume via `--continue` (most recent session in workdir). */
export class HermesAdapter implements AgentAdapter {
  readonly name = 'hermes';

  constructor(private spawnFn: SpawnFn = cp.spawn) {}

  private spawn(args: string[], cwd: string, signal?: AbortSignal): Promise<{ exitCode: number | null; output: string }> {
    return new Promise((resolve) => {
      const child = this.spawnFn('hermes', args, { cwd, signal }) as any;
      let output = '';
      child.stdout.on('data', (d: any) => { output += d.toString(); });
      child.stderr.on('data', (d: any) => { output += d.toString(); });
      child.on('error', (err: any) => resolve({ exitCode: 1, output: `failed to spawn: ${err.message}` }));
      child.on('close', (code: number | null) => resolve({ exitCode: code, output }));
    });
  }

  runTask(run: AgentRun, prompt: string, signal?: AbortSignal) {
    return this.spawn(['chat', '-q', prompt], run.workdir, signal);
  }

  resumeTask(run: AgentRun, followUp: string, signal?: AbortSignal) {
    // hermes chat -q "<followUp>" --continue — continues most recent session in workdir.
    return this.spawn(['chat', '-q', followUp, '--continue'], run.workdir, signal);
  }
}
