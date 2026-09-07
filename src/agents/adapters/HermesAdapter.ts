import * as cp from 'child_process';
import { AgentAdapter } from './types';
import { AgentRun } from '../types';
import { resolveSpawn } from '../resolveBin';

/** Minimal spawn signature — loose enough for test fakes, matches cp.spawn. */
export type SpawnFn = (bin: string, args: string[], opts: any) => any;

/** Hermes: `hermes chat -q "<prompt>"` one-shot; resume via `--continue` (most recent session in workdir). */
export class HermesAdapter implements AgentAdapter {
  readonly name = 'hermes';

  constructor(private spawnFn: SpawnFn = cp.spawn) {}

  private spawn(bin: string, args: string[], cwd: string, signal?: AbortSignal, onChunk?: (chunk: string) => void): Promise<{ exitCode: number | null; output: string }> {
    return new Promise((resolve) => {
      // Spawn the SAME executable detection verified (run.bin) — on Windows a
      // `.cmd` shim is routed through cmd.exe (see resolveSpawn).
      const resolved = resolveSpawn(bin, args);
      const child = this.spawnFn(resolved.bin, resolved.args, { cwd, signal, ...resolved.opts }) as any;
      let output = '';
      child.stdout.on('data', (d: any) => {
        const text = d.toString();
        output += text;
        onChunk?.(text);
      });
      child.stderr.on('data', (d: any) => {
        const text = d.toString();
        output += text;
        onChunk?.(text);
      });
      child.on('error', (err: any) => resolve({ exitCode: 1, output: `failed to spawn: ${err.message}` }));
      child.on('close', (code: number | null) => resolve({ exitCode: code, output }));
    });
  }

  runTask(run: AgentRun, prompt: string, signal?: AbortSignal, onChunk?: (chunk: string) => void) {
    return this.spawn(run.bin ?? 'hermes', ['chat', '-q', prompt], run.workdir, signal, onChunk);
  }

  resumeTask(run: AgentRun, followUp: string, signal?: AbortSignal, onChunk?: (chunk: string) => void) {
    // hermes chat -q "<followUp>" --continue — continues most recent session in workdir.
    return this.spawn(run.bin ?? 'hermes', ['chat', '-q', followUp, '--continue'], run.workdir, signal, onChunk);
  }
}
