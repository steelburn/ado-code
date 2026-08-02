import * as cp from 'child_process';
import { AgentAdapter } from './types';
import { AgentRun } from '../types';

/** Hermes: `hermes chat -q "<prompt>"` one-shot; resume via `--continue` (most recent session in workdir). */
export class HermesAdapter implements AgentAdapter {
  readonly name = 'hermes';

  private spawn(args: string[], cwd: string, signal?: AbortSignal): Promise<{ exitCode: number | null; output: string }> {
    return new Promise((resolve) => {
      const child = cp.spawn('hermes', args, { cwd, signal });
      let output = '';
      child.stdout.on('data', d => { output += d.toString(); });
      child.stderr.on('data', d => { output += d.toString(); });
      child.on('error', err => resolve({ exitCode: 1, output: `failed to spawn: ${err.message}` }));
      child.on('close', code => resolve({ exitCode: code, output }));
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
